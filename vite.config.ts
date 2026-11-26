import { defineConfig } from 'vite'
import preact from '@preact/preset-vite'

export default defineConfig({
  root: 'src/ui',
  base: '/admin/',
  plugins: [preact()],
  build: {
    outDir: '../../dist/ui',
    emptyOutDir: true,
    target: 'es2022',
  },
  server: {
    port: 5173,
    proxy: {
      '/admin/api': 'http://127.0.0.1:8080',
      '/v1': 'http://127.0.0.1:8080',
      '/healthz': 'http://127.0.0.1:8080',
    },
  },
})
