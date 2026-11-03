import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8000',
      '/books': 'http://localhost:8000',
      '/analysis': 'http://localhost:8000',
      '/search': 'http://localhost:8000',
      '/chat': 'http://localhost:8000',
    },
  },
})
