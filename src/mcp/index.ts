/**
 * Drift MCP server. Stdio transport, launched by Claude Code, Cursor or any MCP
 * client. Runs under the app's own binary with ELECTRON_RUN_AS_NODE=1 so nothing
 * else needs installing.
 *
 * Trust boundary: reads the root the user granted in the app (from the SQLite
 * store, read-only) and nothing outside it. Returns key names, drift classes,
 * counts and dry-run plans. Never a value, never a fingerprint, and there is no
 * tool that writes or syncs anything.
 */
import { resolve, join } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { DatabaseSync } from 'node:sqlite'
import { envKind } from '@shared/env-file'
import { planSync } from '@shared/drift'
import { PRODUCT } from '@shared/product'
import { grantRoot, scanWorkspace } from '../main/workspace'
import { compareFiles, envShape } from '../main/env'

const dbArg = process.argv.indexOf('--db')
const dbPath = dbArg > -1 ? process.argv[dbArg + 1] : null
if (!dbPath) {
  process.stderr.write(`usage: ${PRODUCT} MCP --db <path to plumbr.db>\n`)
  process.exit(2)
}

/** The root granted in the app. Re-read per call so a new grant in the app applies immediately. */
function root(): string {
  const db = new DatabaseSync(dbPath!, { readOnly: true })
  try {
    const row = db.prepare('SELECT path FROM roots ORDER BY granted_at DESC LIMIT 1').get()
    const path = row?.['path'] as string | undefined
    if (!path) throw new Error(`No workspace granted yet. Open ${PRODUCT} and choose a folder.`)
    grantRoot(path)
    return path
  } finally {
    db.close()
  }
}

/** Paths from the client are relative to the root; assertGranted in env.ts refuses anything outside. */
const abs = (rel: string): string => resolve(join(root(), rel))

const text = (v: unknown): { content: { type: 'text'; text: string }[] } => ({
  content: [{ type: 'text', text: JSON.stringify(v, null, 2) }]
})

const server = new McpServer({ name: `${PRODUCT.toLowerCase()}-mcp`, version: '0.1.0' })

server.registerTool(
  'list_projects',
  {
    title: 'List projects and env files',
    description:
      'Every .env* file in the granted workspace, grouped by Git project. Metadata only: name, kind (base/local/staging/preview/production/example), relative path, size, modified time.',
    inputSchema: {}
  },
  async () => {
    const scan = await scanWorkspace(root())
    const projects: Record<string, object[]> = {}
    for (const f of scan.files) {
      const p = f.project ?? '(no git project)'
      ;(projects[p] ??= []).push({
        rel: f.rel,
        name: f.name,
        kind: envKind(f.name),
        size: f.size,
        modifiedAt: new Date(f.modifiedAt).toISOString()
      })
    }
    return text({ root: scan.root, projects })
  }
)

server.registerTool(
  'env_status',
  {
    title: 'Env file status',
    description:
      'Key names of one env file with which are blank. Values are never returned. `path` is relative to the workspace root, as given by list_projects.',
    inputSchema: { path: z.string().min(1) }
  },
  async ({ path }) => {
    const shape = await envShape(abs(path))
    return text({
      path,
      keys: shape.entries.map((e) => e.key),
      blank: shape.entries.filter((e) => e.fingerprint === null).map((e) => e.key)
    })
  }
)

server.registerTool(
  'compare_env',
  {
    title: 'Drift receipt between two env files',
    description:
      'Compare source (left) to target (right). Each key gets a class: same, changed, missing (in left only), extra (in right only), blank, ignored. Compared as local fingerprints; values never returned.',
    inputSchema: {
      left: z.string().min(1),
      right: z.string().min(1),
      ignore: z.array(z.string()).default(['NODE_ENV'])
    }
  },
  async ({ left, right, ignore }) => {
    const r = await compareFiles(abs(left), abs(right), ignore)
    return text({ left, right, clean: r.clean, counts: r.counts, rows: r.rows })
  }
)

server.registerTool(
  'dry_run_plan',
  {
    title: 'Dry-run sync plan',
    description:
      'What a human-approved sync from left to right would do per key: add, update, keep or review. Descriptive only. This server cannot execute a sync; extra keys on the target are never removed.',
    inputSchema: {
      left: z.string().min(1),
      right: z.string().min(1),
      ignore: z.array(z.string()).default(['NODE_ENV'])
    }
  },
  async ({ left, right, ignore }) => {
    const r = await compareFiles(abs(left), abs(right), ignore)
    return text({ left, right, actions: planSync(r) })
  }
)

void server.connect(new StdioServerTransport())
