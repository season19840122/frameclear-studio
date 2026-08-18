import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import fs from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { getSettings } from './db.js'
import type { Region, Task } from './types.js'

const exec = promisify(execFile)

export async function probe(filePath: string, mediaType: 'image' | 'video') {
  if (mediaType === 'image') { const m = await sharp(filePath).metadata(); return { width: m.width ?? null, height: m.height ?? null, duration: null } }
  const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=width,height', '-of', 'json', filePath])
  const p = JSON.parse(stdout); const stream = p.streams?.find((item: { width?: number }) => item.width) ?? {}
  return { width: stream.width ?? null, height: stream.height ?? null, duration: p.format?.duration ? Number(p.format.duration) : null }
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
const safeRegions = (regions: Region[]) => regions.filter(region => Number.isFinite(region.x) && Number.isFinite(region.y) && region.width > 0 && region.height > 0).map(region => ({ ...region, x: clamp(region.x, 0, 100), y: clamp(region.y, 0, 100), width: clamp(region.width, 0.2, 100), height: clamp(region.height, 0.2, 100) }))
const expr = (value: number) => Number(value.toFixed(5)).toString()
const rangeEnable = (task: Task) => task.videoRange.kind === 'custom' ? `:enable='between(t,${expr(task.videoRange.start)},${expr(task.videoRange.end)})'` : ''
const regionBounds = (region: Region, width: number, height: number) => {
  const patchWidth = Math.min(width, Math.max(2, Math.round(width * region.width / 100)))
  const patchHeight = Math.min(height, Math.max(2, Math.round(height * region.height / 100)))
  return { left: Math.min(width - patchWidth, Math.max(0, Math.round(width * region.x / 100))), top: Math.min(height - patchHeight, Math.max(0, Math.round(height * region.y / 100))), width: patchWidth, height: patchHeight }
}

function runFfmpeg(args: string[], signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    const abort = () => child.kill('SIGTERM')
    signal?.addEventListener('abort', abort, { once: true })
    child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-4000) })
    child.on('error', error => { signal?.removeEventListener('abort', abort); reject(error) })
    child.on('close', code => {
      signal?.removeEventListener('abort', abort)
      if (signal?.aborted) return reject(Object.assign(new Error('处理已中止'), { name: 'AbortError' }))
      if (code === 0) return resolve()
      reject(new Error(`视频处理失败：${stderr.split('\n').filter(Boolean).at(-1) ?? `FFmpeg 退出码 ${code}`}`))
    })
  })
}

async function createEditMask(width: number, height: number, regions: Region[]) {
  const rectangles = regions.map(region => `<rect x="${Math.round(width * region.x / 100)}" y="${Math.round(height * region.y / 100)}" width="${Math.ceil(width * region.width / 100)}" height="${Math.ceil(height * region.height / 100)}" fill="white"/>`).join('')
  const cuts = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${rectangles}</svg>`)
  return sharp({ create: { width, height, channels: 4, background: '#ffffff' } }).composite([{ input: cuts, blend: 'dest-out' }]).png().toBuffer()
}

async function createLogoMask(width: number, height: number, regions: Region[]) {
  const rectangles = regions.map(region => `<rect x="${Math.round(width * region.x / 100)}" y="${Math.round(height * region.y / 100)}" width="${Math.ceil(width * region.width / 100)}" height="${Math.ceil(height * region.height / 100)}" fill="white"/>`).join('')
  const overlay = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${rectangles}</svg>`)
  return sharp({ create: { width, height, channels: 3, background: '#000000' } }).composite([{ input: overlay }]).grayscale().png().toBuffer()
}

async function repairImageLocally(task: Task, output: string, width: number, height: number, regions: Region[], signal?: AbortSignal) {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'frameclear-repair-'))
  const maskPath = path.join(temporaryDirectory, 'mask.png')
  const repairedPath = path.join(temporaryDirectory, 'repaired.png')
  try {
    await fs.writeFile(maskPath, await createLogoMask(width, height, regions))
    await runFfmpeg(['-y', '-i', task.inputPath, '-vf', `removelogo=f=${maskPath}`, '-frames:v', '1', repairedPath], signal)
    const [original, repaired] = await Promise.all([
      sharp(task.inputPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
      sharp(repairedPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    ])
    if (original.info.width !== width || original.info.height !== height || repaired.info.width !== width || repaired.info.height !== height) throw new Error('局部修复输出尺寸异常，已停止写入结果。')
    const pixels = Buffer.from(original.data)
    for (const region of regions) {
      const bounds = regionBounds(region, width, height)
      for (let row = bounds.top; row < bounds.top + bounds.height; row++) {
        const start = (row * width + bounds.left) * 4
        repaired.data.copy(pixels, start, start, start + bounds.width * 4)
      }
    }
    const composed = sharp(pixels, { raw: { width, height, channels: 4 } })
    await (task.outputFormat === 'jpg' ? composed.jpeg({ quality: task.quality }) : composed.png()).toFile(output)
  } finally { await fs.rm(temporaryDirectory, { recursive: true, force: true }) }
}

async function repairImageWithOpenAI(task: Task, output: string, width: number, height: number, regions: Region[], signal?: AbortSignal) {
  const key = process.env.OPENAI_API_KEY
  if (!key) throw new Error('智能修复需要配置 OPENAI_API_KEY；为避免伪修复，本次任务未处理。')
  const mask = await createEditMask(width, height, regions)
  const form = new FormData()
  form.append('model', process.env.OPENAI_IMAGE_MODEL ?? 'gpt-image-1')
  form.append('image', new Blob([await fs.readFile(task.inputPath)], { type: task.mimeType }), path.basename(task.filename))
  form.append('mask', new Blob([mask], { type: 'image/png' }), 'repair-mask.png')
  form.append('prompt', 'Remove only the content inside the transparent mask. Reconstruct the covered background naturally. Preserve every unmasked pixel, subject, composition, text, and color exactly.')
  form.append('size', 'auto')
  form.append('output_format', 'png')
  const response = await fetch('https://api.openai.com/v1/images/edits', { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form, signal })
  const body = await response.json() as { data?: { b64_json?: string }[]; error?: { message?: string } }
  if (!response.ok || !body.data?.[0]?.b64_json) throw new Error(`智能修复失败：${body.error?.message ?? '修复服务没有返回图片'}`)
  const repaired = Buffer.from(body.data[0].b64_json, 'base64')
  if (task.outputFormat === 'jpg') await sharp(repaired).jpeg({ quality: task.quality }).toFile(output)
  else await sharp(repaired).png().toFile(output)
}

function videoFilter(task: Task, regions: Region[]) {
  let last = '0:v'; const filters: string[] = []; const enable = rangeEnable(task)
  regions.forEach((region, index) => {
    const width = task.width ?? 1, height = task.height ?? 1; const x = String(Math.round(width * region.x / 100)), y = String(Math.round(height * region.y / 100)), w = String(Math.max(2, Math.round(width * region.width / 100))), h = String(Math.max(2, Math.round(height * region.height / 100)));
    const output = `v${index}`
    if (task.mode === 'solid') filters.push(`[${last}]drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=black@0.82:t=fill${enable}[${output}]`)
    else if (task.mode === 'smart' || task.mode === 'crop') filters.push(`[${last}]delogo=x=${x}:y=${y}:w=${w}:h=${h}:show=0${enable}[${output}]`)
    else {
      const base = `base${index}`, source = `source${index}`, patch = `patch${index}`
      filters.push(`[${last}]split=2[${base}][${source}]`, `[${source}]crop=w=${w}:h=${h}:x=${x}:y=${y},gblur=sigma=8[${patch}]`, `[${base}][${patch}]overlay=x=${x}:y=${y}${enable}[${output}]`)
    }
    last = output
  })
  return { graph: filters.join(';'), output: last }
}

export async function processTask(task: Task, onProgress: (progress: number, step: string) => void, signal?: AbortSignal) {
  const outputDir = path.resolve(process.cwd(), task.outputDirectory); await fs.mkdir(outputDir, { recursive: true }); await fs.access(outputDir)
  const base = path.parse(task.filename).name.normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').trim() || 'processed-media'; const ext = task.mediaType === 'image' ? (task.outputFormat === 'jpg' ? 'jpg' : 'png') : 'mp4'; const out = path.join(outputDir, `${base}-${task.id.slice(0, 8)}-clean.${ext}`)
  const regions = safeRegions(task.regions)
  if (!regions.length) throw new Error('处理区域无效，请重新框选至少一个有效区域。')
  onProgress(12, '正在读取媒体信息')
  if (task.mediaType === 'image') {
    let image = sharp(task.inputPath); const meta = await image.metadata(); const width = meta.width ?? 1; const height = meta.height ?? 1
    if (task.mode === 'smart') { onProgress(35, '正在进行 AI 智能修复'); await repairImageWithOpenAI(task, out, width, height, regions, signal) }
    else {
      if (task.mode === 'crop') { onProgress(35, '正在进行原尺寸局部修复'); await repairImageLocally(task, out, width, height, regions, signal) }
      else {
        const composites = await Promise.all(regions.map(async region => {
          const rw = Math.min(width, Math.max(2, Math.round(width * region.width / 100))); const rh = Math.min(height, Math.max(2, Math.round(height * region.height / 100))); const left = Math.min(width - rw, Math.max(0, Math.round(width * region.x / 100))); const top = Math.min(height - rh, Math.max(0, Math.round(height * region.y / 100)))
          if (task.mode === 'solid') return { input: await sharp({ create: { width: rw, height: rh, channels: 4, background: '#1f2937' } }).png().toBuffer(), left, top }
          return { input: await sharp(task.inputPath).extract({ left, top, width: rw, height: rh }).blur(24).toBuffer(), left, top }
        }))
        image = image.composite(composites)
      }
      if (task.mode !== 'crop') {
        onProgress(65, '正在覆盖选区')
        await (ext === 'jpg' ? image.jpeg({ quality: task.quality }) : image.png()).toFile(out)
      }
    }
  } else {
    onProgress(35, task.mode === 'smart' ? '正在进行视频智能修复' : task.mode === 'crop' ? '正在进行原尺寸局部修复' : '正在处理视频选区')
    const filter = videoFilter(task, regions); const threads = Math.max(1, Math.floor(os.cpus().length * getSettings().maxResourcePercent / 100))
    await runFfmpeg(['-y', '-i', task.inputPath, '-filter_complex', filter.graph, '-map', `[${filter.output}]`, '-map', '0:a?', '-c:v', 'libx264', '-crf', String(Math.max(16, 32 - Math.round(task.quality / 7))), '-threads', String(threads), '-c:a', 'aac', out], signal)
  }
  onProgress(94, '正在写入输出文件')
  const info = await fs.stat(out)
  return { outputPath: out, outputSize: info.size }
}
