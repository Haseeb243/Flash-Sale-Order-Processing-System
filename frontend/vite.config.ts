import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // Empty prefix: load non-VITE_ vars too. They are used here only and never reach the browser bundle.
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [react()],
    server: {
      port: 5173,
      strictPort: true,
      proxy: {
        '/api': env.API_PROXY_TARGET || 'http://localhost:4000',
      },
    },
  }
})
