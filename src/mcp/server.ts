/**
 * Drift MCP server. Stdio transport, launched by Claude Code, Cursor or any MCP
 * client. Runs under the app's own binary with ELECTRON_RUN_AS_NODE=1 so nothing
 * else needs installing.
 *
 * Two kinds of tool, one trust boundary:
 *   - Folder, SSH and Docker reads (`list_projects`, `env_status`, `compare_env`,
 *     `dry_run_plan`) work on their own from the roots granted in the app.
 *   - Sources, cross-source compare, plans and sync (`list_sources`,
 *     `compare_projects`, `create_sync_plan`, `request_sync_approval`, `apply_sync`) are answered by the
 *     running app over its local authenticated bridge (src/main/bridge.ts). The
 *     app holds every credential and does every read and write; this process
 *     relays key names, classes, counts and opaque ids. Never a value, never a
 *     fingerprint, never a token. Without the app those tools fail closed.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { DatabaseSync } from 'node:sqlite'
import { dirname } from 'node:path'
import { envKind } from '@shared/env-file'
import { planSync } from '@shared/drift'
import { PRODUCT } from '@shared/product'
import { grantRoot, revokeRoots, scanWorkspace } from '../main/workspace'
import { joinRef, parseRef } from '../main/fs'
import { compareFiles, envShape } from '../main/env'
import { callBridge } from './bridge-client'

const text = (v: unknown): { content: { type: 'text'; text: string }[] } => ({
  content: [{ type: 'text', text: JSON.stringify(v, null, 2) }]
})

export function createMcpServer(dbPath: string): McpServer {
  /**
   * The roots granted in the app (local folders and ssh://host/path). Re-read per
   * call so a new grant and the MCP toggle apply immediately.
   */
  function roots(): string[] {
    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      const meta = (k: string): string | null =>
        (db.prepare('SELECT value FROM meta WHERE key = ?').get(k)?.['value'] as
          string | undefined) ?? null
      if (meta('mcp_enabled') === '0') throw new Error(`MCP is turned off in ${PRODUCT} settings.`)
      // Only the active workspace, exactly like the app.
      const active = Number(meta('active_workspace') ?? 1)
      const rows = db
        .prepare('SELECT path FROM roots WHERE workspace_id = ? ORDER BY granted_at ASC')
        .all(active) as { path: string }[]
      if (rows.length === 0)
        throw new Error(`No workspace granted yet. Open ${PRODUCT} and choose a folder.`)
      // Vault and provider sources need the app's credentials; this process never has
      // them. Those roots are served by the app through list_sources / compare_projects.
      const usable = rows.filter((r) => ['local', 'ssh', 'docker'].includes(parseRef(r.path).kind))
      if (usable.length === 0)
        throw new Error(
          `The active source is a Vault or platform source. Use list_sources, compare_projects and create_sync_plan (the ${PRODUCT} app answers those), or switch to a folder, SSH or Docker source.`
        )
      revokeRoots()
      for (const r of usable) grantRoot(r.path)
      return usable.map((r) => r.path)
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
  const rootParam = z
    .string()
    .optional()
    .describe('Root from list_projects; optional with one root')
  const bridge = (method: string, params: unknown): Promise<unknown> =>
    callBridge(dirname(dbPath), method, params)

  const server = new McpServer({ name: `${PRODUCT.toLowerCase()}-mcp`, version: '0.2.0' })

  server.registerTool(
    'list_projects',
    {
      title: 'List projects and env files',
      description:
        'Every .env* file in the granted folder, SSH or Docker workspace, grouped by Git project. Metadata only: name, kind (base/local/staging/preview/production/example), relative path, size, modified time. Works without the app open. For platform and Vault sources use list_sources.',
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
        'Compare source (left) to target (right) inside one granted folder, SSH or Docker root. Each key gets a class: same, changed, missing (in left only), extra (in right only), blank, ignored. Compared as local fingerprints; values never returned. For two different sources use create_sync_plan.',
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
        'What a sync from left to right would do per key: add, update, keep or review. Descriptive only; nothing is written. To actually sync, use create_sync_plan then apply_sync (the app must be open). Extra keys on the target are never removed.',
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

  /* ---------- answered by the running app over the local bridge ---------- */

  const side = z.object({
    root: z.string().min(1).describe('A source root exactly as list_sources returns it'),
    project: z
      .string()
      .min(1)
      .nullable()
      .describe('A project from that source (null = files outside any Git project)')
  })
  const fileSide = z.object({
    root: z.string().min(1).describe('A source root exactly as list_sources returns it'),
    path: z
      .string()
      .min(1)
      .describe('An env file path relative to that root, as list_sources lists it')
  })

  server.registerTool(
    'list_sources',
    {
      title: 'List every source',
      description: `Every source remembered in ${PRODUCT}, across workspaces: folders, SSH hosts, Docker containers, Vault and platforms (Vercel, Railway, Render, Coolify, GitHub Actions, Dokploy, AWS Secrets Manager, ECS). Each with its root, kind, label, workspace, projects and env files (names only). Needs the ${PRODUCT} app open. Never returns a value.`,
      inputSchema: {}
    },
    async () => text(await bridge('list_sources', {}))
  )

  server.registerTool(
    'compare_projects',
    {
      title: 'Compare two projects across sources',
      description:
        'Pair the env files of project A (source A) with project B (source B) by their path inside the project, then compare each pair. Returns matched pairs with per-pair drift counts, files only on one side, and ambiguous files. Sources and project paths may differ, exactly like the desktop project picker. Needs the app open. Counts and names only.',
      inputSchema: { left: side, right: side }
    },
    async (args) => text(await bridge('compare_projects', args))
  )

  server.registerTool(
    'create_sync_plan',
    {
      title: 'Create a sync plan (left → right)',
      description:
        'Compare one env file on source A (left, the reference) with one on source B (right, the target) and get a plan: an opaque plan_id, key names with their action (add, update, review, keep) and counts. Nothing is written. Review it with the user, then request_sync_approval (the user confirms in the app) and apply_sync. Plans expire after 15 minutes and are single use. Needs the app open.',
      inputSchema: {
        left: fileSide,
        right: fileSide,
        ignore: z.array(z.string()).default(['NODE_ENV'])
      }
    },
    async (args) => text(await bridge('create_sync_plan', args))
  )

  server.registerTool(
    'request_sync_approval',
    {
      title: 'Ask the user to approve a sync',
      description: `Shows the user a native ${PRODUCT} dialog naming the plan's source, target and exactly these keys, and waits for their click. Only their explicit confirmation returns an approval token (one use, 5 minutes, bound to this plan and this ordered key list); Cancel returns an error and nothing is written. Call after the user has reviewed the plan with you. Do not retry in a loop.`,
      inputSchema: {
        plan_id: z.string().min(1),
        keys: z.array(z.string().min(1)).min(1).describe('The keys to write, each once, in order')
      }
    },
    async (args) => text(await bridge('request_sync_approval', args))
  )

  server.registerTool(
    'apply_sync',
    {
      title: 'Apply an approved sync plan',
      description: `WRITES to the plan's target. Copies the approved keys' values from left to right inside the ${PRODUCT} app (files, SSH, Docker, Vault and platforms alike), after the app re-checks that neither side changed since the plan. Pass the plan_id, the same keys in the same order, and the approval token request_sync_approval returned after the user clicked. The token is consumed on use. Blank or unreadable source values are skipped; extra keys on the target are never removed. Returns written and skipped key names, verification state and a snapshot id. Never a value.`,
      inputSchema: {
        plan_id: z.string().min(1),
        keys: z.array(z.string().min(1)).min(1),
        approval: z.string().min(1).describe('The token from request_sync_approval')
      }
    },
    async (args) => text(await bridge('apply_sync', args))
  )

  return server
}
