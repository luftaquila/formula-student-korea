import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  server: {
    proxy: {
      '/all': {
        target: 'http://localhost:9000',
        changeOrigin: true
      },
      '/team': {
        target: 'http://localhost:9000',
        changeOrigin: true
      },
      '/upload': {
        target: 'http://localhost:9000',
        changeOrigin: true
      },
      '/enroll': {
        target: 'http://localhost:9000',
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true
  }
})

