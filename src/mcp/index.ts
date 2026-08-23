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
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { DatabaseSync } from 'node:sqlite'
import { envKind } from '@shared/env-file'
import { planSync } from '@shared/drift'
import { PRODUCT } from '@shared/product'
import { licenseState } from '@shared/license'
import { grantRoot, scanWorkspace } from '../main/workspace'
import { joinRef } from '../main/fs'
import { compareFiles, envShape } from '../main/env'

const dbArg = process.argv.indexOf('--db')
const dbPath = dbArg > -1 ? process.argv[dbArg + 1] : null
if (!dbPath) {
  process.stderr.write(`usage: ${PRODUCT} MCP --db <path to plumbr.db>\n`)
  process.exit(2)
}

/**
 * The roots granted in the app (local folders and ssh://host/path). Re-read per
 * call so a new grant, the MCP toggle and the license all apply immediately.
 */
function roots(): string[] {
  const db = new DatabaseSync(dbPath!, { readOnly: true })
  try {
    const meta = (k: string): string | null =>
      (db.prepare('SELECT value FROM meta WHERE key = ?').get(k)?.['value'] as
        string | undefined) ?? null
    if (meta('mcp_enabled') === '0') throw new Error(`MCP is turned off in ${PRODUCT} settings.`)
    const lic = licenseState({
      key: meta('license_key'),
      trialStartedAt: Number(meta('trial_started_at') ?? Date.now()),
      lastSeen: Number(meta('last_seen') ?? 0)
    })
    if (lic.state === 'expired')
      throw new Error(`${PRODUCT} trial has ended. Enter a license key in the app.`)
    const rows = db.prepare('SELECT path FROM roots ORDER BY granted_at ASC').all() as {
      path: string
    }[]
    if (rows.length === 0)
      throw new Error(`No workspace granted yet. Open ${PRODUCT} and choose a folder.`)
    for (const r of rows) grantRoot(r.path)
    return rows.map((r) => r.path)
  } finally {
    db.close()
  }
}

/**
 * Paths from the client are `<root>` + relative path as returned by list_projects.
 * With one root the root may be omitted. assertGranted refuses anything outside.
 */
const abs = (rel: string, root?: string): string => {
  const all = roots()
  const r = root ?? (all.length === 1 ? all[0] : null)
  if (!r) throw new Error('Several roots are granted: pass `root` from list_projects.')
  if (!all.includes(r)) throw new Error(`Unknown root ${r}`)
  return joinRef(r, rel)
}
const rootParam = z.string().optional().describe('Root from list_projects; optional with one root')

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
    const out: { root: string; projects: Record<string, object[]> }[] = []
    for (const root of roots()) {
      const scan = await scanWorkspace(root)
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
      out.push({ root, projects })
    }
    return text({ roots: out })
  }
)

server.registerTool(
  'env_status',
  {
    title: 'Env file status',
    description:
      'Key names of one env file with which are blank. Values are never returned. `path` is relative to the workspace root, as given by list_projects.',
    inputSchema: { path: z.string().min(1), root: rootParam }
  },
  async ({ path, root }) => {
    const shape = await envShape(abs(path, root))
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
      ignore: z.array(z.string()).default(['NODE_ENV']),
      root: rootParam
    }
  },
  async ({ left, right, ignore, root }) => {
    const r = await compareFiles(abs(left, root), abs(right, root), ignore)
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
      ignore: z.array(z.string()).default(['NODE_ENV']),
      root: rootParam
    }
  },
  async ({ left, right, ignore, root }) => {
    const r = await compareFiles(abs(left, root), abs(right, root), ignore)
    return text({ left, right, actions: planSync(r) })
  }
)

void server.connect(new StdioServerTransport())
