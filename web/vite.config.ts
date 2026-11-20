/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// In the dev container the API is reachable as http://api:8787; on the host it
// is published on 127.0.0.1:8790. Proxying /v1 keeps the browser on one origin,
// so the session cookie and the API's origin check work without CORS.
const apiTarget = process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:8790'
const port = Number(process.env.WEB_PORT ?? 5190)

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port,
    strictPort: true,
    proxy: {
      '/v1': { target: apiTarget, changeOrigin: false },
      '/health': { target: apiTarget, changeOrigin: false },
    },
  },
  preview: { port, strictPort: true },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: { modules: { classNameStrategy: 'non-scoped' } },
  },
})
