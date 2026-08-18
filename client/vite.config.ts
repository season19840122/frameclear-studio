import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({ base: process.env.GITHUB_ACTIONS === 'true' ? '/frameclear-studio/' : '/', plugins: [vue()], server: { port: 5173, proxy: { '/api': 'http://localhost:8787', '/files': 'http://localhost:8787' } } })
