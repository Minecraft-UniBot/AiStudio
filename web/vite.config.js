import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 9877,
    proxy: {
      // 仅代理 REST，不代理 WebSocket（避免 Bun 下 http-proxy 兼容问题，WS 由前端直连后端）
      '/api/studio': 'http://127.0.0.1:9876',
    },
  },
})
