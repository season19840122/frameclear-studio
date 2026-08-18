const base = process.env.TEST_BASE_URL ?? 'http://localhost:8787'
const health = await fetch(`${base}/api/health`).then(r=>r.json()) as {ok:boolean}
if (!health.ok) throw new Error('health check failed')
const settings = await fetch(`${base}/api/settings`).then(r=>r.json()) as {concurrency:number}
if (![1,2,3,5,10].includes(settings.concurrency)) throw new Error('invalid default concurrency')
console.log('API smoke tests passed')
