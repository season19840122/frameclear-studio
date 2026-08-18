<script setup lang="ts">
import { BarChart3, Clock3, FolderClock, PlusSquare, Settings } from 'lucide-vue-next'
defineProps<{active:string}>(); defineEmits<{navigate:[page:string]}>()
const items=[['dashboard','概览',BarChart3],['editor','新建处理',PlusSquare],['queue','任务队列',FolderClock],['history','处理历史',Clock3],['settings','设置',Settings]] as const
</script>
<template><aside class="sidebar"><button class="brand" @click="$emit('navigate','dashboard')"><span class="brand-mark">✦</span><span>FrameClear Studio</span></button><nav><button v-for="[id,label,icon] in items" :key="id" :class="{active:active===id}" @click="$emit('navigate',id)"><component :is="icon" :size="20"/><span>{{label}}</span></button></nav><div class="sidebar-note">本地处理 · 数据安全<br><small>仅处理有权编辑的素材</small></div></aside></template>
