import { reactive } from 'vue'
import { api } from '../lib/api'
import type { Settings, Task } from '../types'
export const state = reactive<{tasks:Task[]; settings:Settings|null; toast:string}>({tasks:[],settings:null,toast:''})
export async function refresh(){ state.tasks=await api.tasks(); state.settings=await api.settings() }
export function notify(message:string){state.toast=message;window.setTimeout(()=>{if(state.toast===message)state.toast=''},3600)}
