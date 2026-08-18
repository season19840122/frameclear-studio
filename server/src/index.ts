import 'dotenv/config'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import express from 'express'
import cors from 'cors'
import multer from 'multer'
import { getSettings, saveSettings, tasks } from './db.js'
import { probe } from './processor.js'
import { queue } from './queue.js'
import type { Region, RemovalMode, Task, VideoRange } from './types.js'

const app = express(); const root = process.cwd(); const uploadDir = path.join(root, 'uploads'); fs.mkdirSync(uploadDir, { recursive: true })
const allow = new Set(['image/jpeg','image/png','image/webp','video/mp4','video/quicktime','video/webm'])
const upload = multer({ dest: uploadDir, limits: { fileSize: Number(process.env.MAX_FILE_SIZE_MB ?? 500) * 1024 * 1024 }, fileFilter: (_req, file, cb) => cb(null, allow.has(file.mimetype)) })
const restoreUploadFilename = (filename: string) => { const restored = Buffer.from(filename, 'latin1').toString('utf8'); return restored.includes('�') ? filename : restored }
app.use(cors()); app.use(express.json({ limit: '2mb' })); app.use('/files', express.static(root))
app.get('/api/health', (_req,res) => res.json({ ok: true, queue: 'ready', database: 'connected' }))
app.get('/api/tasks', (_req,res) => res.json(tasks.list()))
app.get('/api/settings', (_req,res) => res.json(getSettings()))
app.post('/api/settings/select-directory', (_req,res) => {
  if (process.platform !== 'darwin') return res.status(501).json({ error: '当前系统暂不支持通过应用选择目录，请手动输入路径。' })
  execFile('osascript', ['-e', 'POSIX path of (choose folder with prompt "选择默认保存目录")'], (error, stdout) => {
    if (error) return res.status(400).json({ error: '未选择目录。' })
    const outputDirectory = stdout.trim()
    try { fs.accessSync(outputDirectory, fs.constants.W_OK) }
    catch { return res.status(400).json({ error: '所选目录不可写，请选择其它目录。' }) }
    res.json({ outputDirectory })
  })
})
app.put('/api/settings', (req,res) => {
  const incoming = req.body as Record<string, unknown>; const current = getSettings()
  const next = { ...current, ...incoming }
  if (!Number.isInteger(Number(next.concurrency)) || Number(next.concurrency) < 1 || Number(next.concurrency) > 10) return res.status(400).json({ error: '并发数量必须在 1 到 10 之间。' })
  if (!Number.isFinite(Number(next.maxFileSizeMb)) || Number(next.maxFileSizeMb) < 10 || Number(next.maxFileSizeMb) > 2000) return res.status(400).json({ error: '文件大小限制必须在 10 到 2000 MB 之间。' })
  if (!Number.isInteger(Number(next.autoRetryCount)) || Number(next.autoRetryCount) < 0 || Number(next.autoRetryCount) > 3) return res.status(400).json({ error: '自动重试次数必须在 0 到 3 次之间。' })
  if (!Number.isFinite(Number(next.requestTimeoutMinutes)) || Number(next.requestTimeoutMinutes) < 1 || Number(next.requestTimeoutMinutes) > 180) return res.status(400).json({ error: '请求超时必须在 1 到 180 分钟之间。' })
  if (!Number.isFinite(Number(next.maxResourcePercent)) || Number(next.maxResourcePercent) < 10 || Number(next.maxResourcePercent) > 100) return res.status(400).json({ error: '最大处理资源必须在 10% 到 100% 之间。' })
  const outputDirectory = path.resolve(root, String(next.outputDirectory)); try { fs.mkdirSync(outputDirectory, { recursive: true }); fs.accessSync(outputDirectory, fs.constants.W_OK) } catch { return res.status(400).json({ error: '默认保存目录不可写，请选择有写入权限的位置。' }) }
  const saved = saveSettings({ ...next, outputDirectory }); queue.tick(); res.json(saved)
})
app.post('/api/uploads', upload.single('file'), async (req,res) => {
  if (!req.file) return res.status(400).json({ error: '文件格式不支持。仅支持 JPG、PNG、WEBP、MP4、MOV、WEBM。' })
  try { const mediaType = req.file.mimetype.startsWith('image/') ? 'image' : 'video'; const info = await probe(req.file.path, mediaType); res.status(201).json({ uploadId: req.file.filename, filename: restoreUploadFilename(req.file.originalname), mimeType: req.file.mimetype, mediaType, size: req.file.size, inputPath: req.file.path, previewUrl: `/files/uploads/${req.file.filename}`, ...info }) }
  catch { fs.rmSync(req.file.path, { force: true }); res.status(422).json({ error: '文件已损坏、无法读取，或视频编码不兼容。' }) }
})
app.post('/api/tasks', (req,res) => {
  const data = req.body as { filename:string; mimeType:string; mediaType:'image'|'video'; size:number; width:number|null; height:number|null; duration:number|null; inputPath:string; outputFormat?:string; quality?:number; mode?:RemovalMode; regions?:Region[]; videoRange?:VideoRange; authorized?:boolean }
  if (!data.authorized) return res.status(400).json({ error: '请确认你拥有该文件的编辑权或已取得授权。' })
  if (!data.inputPath || !fs.existsSync(data.inputPath)) return res.status(400).json({ error: '源文件不存在或不可访问。' })
  if (!data.regions?.length) return res.status(400).json({ error: '请先在预览上框选需要处理的区域，再加入队列。' })
  const settings = getSettings(); const range = data.videoRange?.kind === 'custom' ? { kind: 'custom' as const, start: Number(data.videoRange.start), end: Number(data.videoRange.end) } : { kind: 'all' as const, start: 0, end: Number(data.duration ?? 0) }
  if (data.mediaType === 'video' && range.kind === 'custom' && (!Number.isFinite(range.start) || !Number.isFinite(range.end) || range.start < 0 || range.end <= range.start || (data.duration !== null && range.end > data.duration))) return res.status(400).json({ error: '视频处理时间范围无效。' })
  const outputFormat = data.mediaType === 'video' ? 'mp4' : (data.outputFormat === 'jpg' ? 'jpg' : 'png')
  const now = new Date().toISOString(); const task: Task = { id: crypto.randomUUID(), filename: data.filename, mimeType: data.mimeType, mediaType: data.mediaType, size: data.size, width: data.width, height: data.height, duration: data.duration, inputPath: data.inputPath, outputPath: null, outputSize: null, outputDirectory: settings.outputDirectory, outputFormat, quality: Number(data.quality ?? settings.defaultQuality), mode: data.mode ?? settings.defaultMode, regions: data.regions ?? [], videoRange: range, retryCount: 0, status: 'Waiting', progress: 0, step: '等待处理', error: null, createdAt: now, updatedAt: now }
  tasks.save(task); queue.tick(); res.status(201).json(task)
})
app.post('/api/tasks/:id/:action', (req,res) => {
  const task = tasks.get(req.params.id); if (!task) return res.status(404).json({ error: '任务不存在' }); const action = req.params.action
  if (action === 'pause') queue.pause(task.id)
  else if (action === 'resume') queue.resume(task.id)
  else if (action === 'cancel') queue.cancel(task.id)
  else if (action === 'retry') queue.retry(task.id)
  else if (action === 'reveal') {
    if (!task.outputPath || !fs.existsSync(task.outputPath)) return res.status(404).json({ error: '处理结果不存在或已被移除。' })
    const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open'
    const args = process.platform === 'darwin' ? ['-R', task.outputPath] : process.platform === 'win32' ? ['/select,', task.outputPath] : [path.dirname(task.outputPath)]
    return execFile(command, args, error => error ? res.status(500).json({ error: '无法打开输出目录，请确认系统文件管理器可用。' }) : res.json({ ok: true, outputPath: task.outputPath }))
  } else return res.status(400).json({ error: '不支持的任务操作' })
  res.json({ ok: true })
})
app.get('/api/tasks/:id/download', (req,res) => { const task = tasks.get(req.params.id); if (!task?.outputPath || !fs.existsSync(task.outputPath)) return res.status(404).json({ error: '处理结果不存在或已被移除。' }); res.download(task.outputPath, path.basename(task.outputPath)) })
app.get('/api/tasks/:id/preview', (req,res) => { const task = tasks.get(req.params.id); if (!task?.outputPath || !fs.existsSync(task.outputPath)) return res.status(404).json({ error: '处理结果不存在或已被移除。' }); res.type(task.mediaType === 'image' ? `image/${task.outputFormat === 'jpg' ? 'jpeg' : 'png'}` : 'video/mp4'); res.sendFile(task.outputPath) })
app.delete('/api/tasks/:id/output', (req,res) => { const task = tasks.get(req.params.id); if (!task?.outputPath) return res.status(404).json({ error: '处理结果不存在或已被移除。' }); try { fs.rmSync(task.outputPath, { force: true }); tasks.save({ ...task, outputPath: null, outputSize: null, updatedAt: new Date().toISOString() }); res.status(204).end() } catch { res.status(500).json({ error: '无法删除输出文件，请确认文件未被其它程序占用。' }) } })
app.delete('/api/tasks/:id', (req,res) => { const task = tasks.get(req.params.id); if (!task) return res.status(404).json({ error: '任务不存在' }); tasks.remove(task.id); res.status(204).end() })
app.get('/api/dashboard', (_req,res) => { const all = tasks.list(); const today = new Date(); const dateKey = (date: Date) => date.toISOString().slice(0, 10); const todays = all.filter(task => dateKey(new Date(task.createdAt)) === dateKey(today)); const completed = all.filter(task=>task.status==='Completed').length; const failed = all.filter(task=>task.status==='Failed').length; const daily = Array.from({ length: 7 }, (_, index) => { const day = new Date(today); day.setDate(today.getDate() - 6 + index); const key = dateKey(day); return { label: `${day.getMonth() + 1}/${day.getDate()}`, count: all.filter(task => dateKey(new Date(task.createdAt)) === key).length } }); const totalBytes = all.reduce((sum,task) => sum + task.size, 0); res.json({ today: todays.length, completed, processing: all.filter(task=>task.status==='Processing').length, failed, totalTasks: all.length, totalBytes, successRate: completed + failed ? Math.round(completed / (completed + failed) * 100) : 0, imageCount: all.filter(task=>task.mediaType==='image').length, videoCount: all.filter(task=>task.mediaType==='video').length, daily, recent: all.slice(0,6) }) })
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => { if (err.name === 'MulterError') return res.status(413).json({ error: '文件过大，超过当前单文件大小限制。' }); res.status(500).json({ error: '服务器处理请求时发生错误。' }) })
const port = Number(process.env.PORT ?? 8787); app.listen(port, () => console.log(`FrameClear API listening at http://localhost:${port}`)); queue.recover()
