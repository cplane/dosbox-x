import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// In production nginx (nginx.conf) serves the bundle and routes /api to the
// gateway and /auth to the auth service on the same origin; locally this
// proxy reproduces that (e.g. kubectl port-forward the two services).
const proxy = {
  '/api': { target: 'http://localhost:8081', ws: true, changeOrigin: true },
  '/auth': { target: 'http://localhost:8091', changeOrigin: true },
  // A box's sidecar straight through (kubectl port-forward pod/dosbox-test 18099:8080), for the workspace harness.
  '/pod': { target: 'http://localhost:18099', ws: true, changeOrigin: true, headers: { Origin: 'http://localhost:18099' }, rewrite: (p: string) => p.replace(/^\/pod/, '') },
}

export default defineConfig({
  plugins: [react()],
  server: { proxy },
  preview: { proxy },
})
