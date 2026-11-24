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
      '/sessions': 'http://localhost:8000',
      '/experts': 'http://localhost:8000',
      '/cards': 'http://localhost:8000',
      '/assets': 'http://localhost:8000',
      '/audio': 'http://localhost:8000',
      '/highlights': 'http://localhost:8000',
      '/guides': 'http://localhost:8000',
    },
  },
})
