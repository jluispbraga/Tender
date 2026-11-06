import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Renderer only for now. replica-build moves this under electron-vite,
// whose renderer root is the same src/renderer folder.
export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': resolve(__dirname, 'src/renderer/src') } },
  build: { outDir: resolve(__dirname, 'out/renderer'), emptyOutDir: true },
})
