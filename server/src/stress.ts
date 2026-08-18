const base = process.env.TEST_BASE_URL ?? 'http://localhost:8787'
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLqVQAAAABJRU5ErkJggg==', 'base64')
const uploadOne = async (index: number) => {
  const form = new FormData(); form.append('file', new Blob([png], { type: 'image/png' }), `stress-authorized-${index}.png`)
  const upload = await fetch(`${base}/api/uploads`, { method: 'POST', body: form }); if (!upload.ok) throw new Error(`upload ${index} failed`)
  const media = await upload.json() as Record<string, unknown>
  const task = await fetch(`${base}/api/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...media, authorized: true, mode: 'blur', outputFormat: 'png', quality: 80, regions: [{ id: `stress-${index}`, x: 0, y: 0, width: 100, height: 100 }], videoRange: { kind: 'all', start: 0, end: 0 } }) }); if (!task.ok) throw new Error(`task ${index} failed`)
}
const settings = await fetch(`${base}/api/settings`).then(r => r.json()) as { concurrency: number }
await Promise.all(Array.from({ length: 20 }, (_, i) => uploadOne(i + 1)))
await new Promise(resolve => setTimeout(resolve, 2500))
const all = await fetch(`${base}/api/tasks`).then(r => r.json()) as { status: string }[]
const completed = all.filter(t => t.status === 'Completed').length
console.log(`Stress test passed: queued 20 authorized image tasks with concurrency limit ${settings.concurrency}; ${completed} total completed tasks now recorded.`)
