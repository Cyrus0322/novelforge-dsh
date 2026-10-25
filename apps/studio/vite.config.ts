import { defineConfig } from 'vite'

const API_TARGET = process.env.NOVELFORGE_API ?? 'http://127.0.0.1:4319'

// 工作台是纯静态 SPA：构建产物由 NovelForge 本地服务（`novelforge studio`）托管，
// 也支持用 `pnpm --filter @novelforge/studio dev` 单独起前端调试（走 /api 代理）。
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
  },
  server: {
    port: 5273,
    strictPort: false,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: false },
    },
  },
})
