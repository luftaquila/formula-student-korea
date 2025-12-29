import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig(({ mode }) => {
  // Only use base path in production mode
  // In development mode (including build:dev), base is empty
  const isProduction = mode === 'production'
  
  return {
    base: isProduction ? '/entry/' : '',
    plugins: [vue()],
    server: {
      proxy: {
        '/api': {
          target: 'http://localhost:9100',
          changeOrigin: true
        }
      }
    },
    build: {
      outDir: 'dist',
      emptyOutDir: true
    }
  }
})

