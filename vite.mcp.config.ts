import { resolve } from 'node:path'
import { builtinModules } from 'node:module'
import { defineConfig } from 'vite'

/**
 * The MCP server is built as ONE self-contained CommonJS file. At launch the app
 * copies it into userData and points MCP clients there, so the path stays valid
 * even when the app itself lives in a temporary AppImage mount.
 */
export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared') } },
  build: {
    ssr: true,
    target: 'node24',
    outDir: 'out/main',
    emptyOutDir: false,
    minify: false,
    rollupOptions: {
      input: resolve('src/mcp/index.ts'),
      external: [...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
      output: { format: 'cjs', entryFileNames: 'mcp.js', inlineDynamicImports: true }
    }
  },
  ssr: { noExternal: true }
})
