import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const shared = { '@shared': resolve('src/shared') }

export default defineConfig({
  main: {
    resolve: { alias: shared },
    build: {
      rollupOptions: {
        // mcp.js is a second entry: plain Node, no electron import. Run as
        // ELECTRON_RUN_AS_NODE=1 <app binary> out/main/mcp.js --db <plumbr.db>
        input: { index: resolve('src/main/index.ts'), mcp: resolve('src/mcp/index.ts') }
      }
    }
  },
  preload: { resolve: { alias: shared } },
  renderer: {
    resolve: {
      alias: {
        '@': resolve('src/renderer/src'),
        ...shared
      }
    },
    plugins: [react(), tailwindcss()]
  }
})
