import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// The desktop app. `vite.config.ts` stays for `dev:design`, which runs the
// renderer alone in a browser on the fake engine.
export default defineConfig({
  main: {
    build: { rollupOptions: { input: resolve(__dirname, 'src/main/index.ts') } },
  },
  preload: {
    // Sandboxed preloads can't use Node's module loader: ship one CommonJS file.
    build: { rollupOptions: { input: resolve(__dirname, 'src/preload/index.ts'), output: { format: 'cjs', entryFileNames: '[name].js' } } },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: [
        { find: '@', replacement: resolve(__dirname, 'src/renderer/src') },
        // The app always has the preload API: leave the fake engine (browser runs only) out.
        { find: /^\.\/fake\/engine$/, replacement: resolve(__dirname, 'src/renderer/src/api/fake/none.ts') },
      ],
    },
    build: {
      rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') },
      // Fonts stay files: the packaged CSP is font-src 'self' (no data: URLs).
      assetsInlineLimit: (file) => (/\.(woff2?|ttf|otf)$/.test(file) ? false : undefined),
    },
  },
})
