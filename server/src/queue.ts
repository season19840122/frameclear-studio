import { getSettings, tasks } from './db.js'
import { processTask } from './processor.js'
import type { Task } from './types.js'

const active = new Set<string>(); const controllers = new Map<string, AbortController>(); const pauseRequested = new Set<string>(); const cancelRequested = new Set<string>(); const timeoutRequested = new Set<string>()
const patch = (task: Task, values: Partial<Task>) => { const next = { ...task, ...values, updatedAt: new Date().toISOString() }; tasks.save(next); return next }

export const queue = {
  tick() { const limit = getSettings().concurrency; for (const task of tasks.list().filter(item => item.status === 'Waiting').slice(0, Math.max(0, limit - active.size))) void this.run(task) },
  async run(task: Task) {
    if (active.has(task.id) || task.status !== 'Waiting') return
    active.add(task.id); const controller = new AbortController(); controllers.set(task.id, controller)
    const timeout = setTimeout(() => { timeoutRequested.add(task.id); controller.abort() }, getSettings().requestTimeoutMinutes * 60_000)
    task = patch(task, { status: 'Processing', step: '准备处理', error: null })
    try {
      const result = await processTask(task, (progress, step) => {
        const current = tasks.get(task.id)
        if (!current || pauseRequested.has(task.id) || cancelRequested.has(task.id) || timeoutRequested.has(task.id)) controller.abort()
        else patch(current, { progress, step })
      }, controller.signal)
      const current = tasks.get(task.id); if (!current) return
      patch(current, { status: 'Completed', progress: 100, step: '处理完成', outputPath: result.outputPath, outputSize: result.outputSize })
    } catch (error) {
      const current = tasks.get(task.id); if (!current) return
      const message = error instanceof Error ? error.message : '处理失败'
      if (pauseRequested.has(task.id)) patch(current, { status: 'Paused', step: '任务已暂停', error: null })
      else if (cancelRequested.has(task.id)) patch(current, { status: 'Cancelled', step: '任务已取消', error: null })
      else if (timeoutRequested.has(task.id)) patch(current, { status: 'Failed', step: '处理超时', error: `处理超过 ${getSettings().requestTimeoutMinutes} 分钟，已安全终止。` })
      else if (current.retryCount < getSettings().autoRetryCount) patch(current, { status: 'Waiting', progress: 0, retryCount: current.retryCount + 1, step: `处理失败，正在进行第 ${current.retryCount + 1} 次自动重试`, error: message })
      else patch(current, { status: 'Failed', step: '处理失败', error: message })
    } finally {
      clearTimeout(timeout); active.delete(task.id); controllers.delete(task.id); pauseRequested.delete(task.id); cancelRequested.delete(task.id); timeoutRequested.delete(task.id); this.tick()
    }
  },
  pause(id: string) {
    const task = tasks.get(id); if (!task) return
    if (task.status === 'Waiting') patch(task, { status: 'Paused', step: '任务已暂停' })
    else if (task.status === 'Processing') { pauseRequested.add(id); controllers.get(id)?.abort() }
  },
  cancel(id: string) {
    const task = tasks.get(id); if (!task) return
    if (task.status === 'Waiting' || task.status === 'Paused') patch(task, { status: 'Cancelled', step: '任务已取消', error: null })
    else if (task.status === 'Processing') { cancelRequested.add(id); controllers.get(id)?.abort() }
  },
  resume(id: string) { const task = tasks.get(id); if (task && task.status === 'Paused') { patch(task, { status: 'Waiting', step: '等待恢复' }); this.tick() } },
  retry(id: string) { const task = tasks.get(id); if (task && ['Failed', 'Cancelled'].includes(task.status)) { patch(task, { status: 'Waiting', progress: 0, retryCount: 0, step: '等待处理', error: null }); this.tick() } },
  recover() { for (const task of tasks.list()) if (['Processing', 'Parsing'].includes(task.status)) patch(task, { status: 'Waiting', progress: 0, step: '服务重启后等待恢复' }); this.tick() }
}
