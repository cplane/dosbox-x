import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// In production nginx (nginx.conf) serves the bundle and routes /api to the
// gateway and /auth to the auth service on the same origin; locally this
// proxy reproduces that (e.g. kubectl port-forward the two services).
const proxy = {
  '/api': { target: 'http://localhost:8081', ws: true, changeOrigin: true },
  '/auth': { target: 'http://localhost:8091', changeOrigin: true },
}

export default defineConfig({
  plugins: [react()],
  server: { proxy },
  preview: { proxy },
})
