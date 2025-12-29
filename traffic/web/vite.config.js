import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig(({ mode }) => {
  // Only use base path in production mode
  // In development mode (including build:dev), base is empty
  const isProduction = mode === 'production'
  
  return {
    base: isProduction ? '/traffic/' : '',
    plugins: [vue()],
    server: {
      port: 5173,
      proxy: {
        '/api': {
          target: 'http://localhost:9200',
          changeOrigin: true
        }
      }
    },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      rollupOptions: {
        input: './index.html'
      }
    },
    resolve: {
      alias: {
        '@': '/src'
      }
    }
  }
})
