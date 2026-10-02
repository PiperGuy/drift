import { createServer, type Server, type Socket } from 'node:net'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { chmodSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, posix, win32 } from 'node:path'
import { z } from 'zod'
import { PRODUCT } from '@shared/product'
import { envKind } from '@shared/env-file'
import { planSync } from '@shared/drift'
import type { EnvFileInfo } from '@shared/channels'
import type { Store } from './store'
import { compareProjects, ensureSourceRoot, toRoot } from './compare'
import { ProjectCompareRequestSchema } from '@shared/ipc'
import { isGranted, scanWorkspace } from './workspace'
import { parseRef } from './fs'
import { compareGuarded } from './env'
import { applyPlan } from './write'

/**
 * Local bridge the bundled MCP server talks to while the app runs. The app is
 * the only authority: every source read, compare, plan and write happens in
 * this process with the credentials it already holds. The MCP side gets back
 * key names, classes, counts and opaque ids. Never a value.
 *
 * Transport: a Unix socket (named pipe on Windows) whose path and a fresh
 * per-launch token live in `<userData>/bridge.json`, mode 0600. One request
 * per connection: a JSON line in, a JSON line out. Both files vanish on quit,
 * so a dead app is an ECONNREFUSED / ENOENT, never a stale authority.
 */
export const CAPABILITY_FILE = 'bridge.json'
export type Capability = { path: string; token: string }
export type Bridge = { path: string; close: () => Promise<void> }

/** What the app shows the user before a sync request is honoured. Names only. */
export type ApprovalPrompt = {
  source: { label: string; path: string }
  target: { label: string; path: string }
  keys: string[]
  consequence: string
}
export type BridgeOptions = {
  /** Native, user-visible confirmation. Resolves true only on an explicit click; cancel, dismiss and errors are false. */
  approve: (prompt: ApprovalPrompt) => Promise<boolean>
}

const MAX_REQUEST = 256 * 1024
/** For the request line only; a handler talking to a provider takes as long as it needs. */
const READ_TIMEOUT = 10_000

type Method = (store: Store, params: unknown, opts: BridgeOptions) => Promise<unknown>
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** The MCP switch is enforced for every bridge request. */
function gate(store: Store): void {
  if (store.getMeta('mcp_enabled') === '0')
    throw new Error(`MCP is turned off in ${PRODUCT} settings.`)
}

/**
 * The only way an agent names a file: a remembered root plus the relative path
 * the scan reported. Absolute paths and `..` never resolve, and the file must
 * be one the scan found, so nothing outside a granted source is ever opened.
 */
async function resolveFile(store: Store, root: string, rel: string): Promise<EnvFileInfo> {
  const norm = rel.replace(/\\/g, '/')
  if (posix.isAbsolute(norm) || win32.isAbsolute(rel) || norm.split('/').includes('..'))
    throw new Error(`${rel}: give a path relative to the source root, without "..".`)
  ensureSourceRoot(store, root)
  const scan = await scanWorkspace(root)
  const file = scan.files.find((f) => f.rel.replace(/\\/g, '/') === norm)
  if (!file || !isGranted(file.path))
    throw new Error(`${rel} is not an env file in ${root}. Use list_sources to see what is there.`)
  return file
}

const PLAN_TTL = 15 * 60_000
type Plan = {
  receipt: number
  left: string
  right: string
  /** The remembered roots both refs resolved against; re-checked at apply time. */
  roots: [string, string]
  expectedMtime: number
  expectedVersion?: number
  /** Keys a plan may write: add, update or review; never `keep` (extra keys are never touched). */
  keys: Set<string>
  expiresAt: number
  used: boolean
  labels: { source: { label: string; path: string }; target: { label: string; path: string } }
  /**
   * Minted by one explicit click in the app, for exactly these ordered keys.
   * Memory only, one at a time, one use: replaced by a newer click, deleted the
   * moment an apply starts, dead with the app. Never logged, never persisted.
   */
  approval?: { token: string; keys: string[]; expiresAt: number }
}
const APPROVAL_TTL = 5 * 60_000
/** In memory only: a plan dies with the app, and an opaque id cannot be forged or reused. */
const plans = new Map<string, Plan>()

const SideSchema = z.object({
  root: z.string().min(1).max(4096),
  path: z.string().min(1).max(4096)
})
const PlanRequestSchema = z.object({
  left: SideSchema,
  right: SideSchema,
  ignore: z.array(z.string().min(1).max(256)).max(500).default(['NODE_ENV'])
})

/** The keys an agent selects: at least one, and each only once, before anything is read. */
const Keys = z
  .array(z.string().min(1).max(256))
  .min(1)
  .max(5000)
  .refine((keys) => new Set(keys).size === keys.length, {
    error: 'Duplicate keys in the selection: list each key once.'
  })
const ApprovalRequestSchema = z.object({ plan_id: z.string().min(1).max(128), keys: Keys })
const ApplyRequestSchema = z.object({
  plan_id: z.string().min(1).max(128),
  keys: Keys,
  approval: z
    .string()
    .min(1)
    .max(128, { error: 'approval must be the token request_sync_approval returned' })
})

/** A live plan whose selection the plan allows, or the actionable error. */
function livePlan(id: string, keys: string[]): Plan {
  const plan = plans.get(id)
  if (!plan) throw new Error('Unknown plan id. Call create_sync_plan first, then request approval.')
  if (plan.used) throw new Error('This plan was already used. Create a new plan, then apply.')
  if (Date.now() > plan.expiresAt) {
    plans.delete(id)
    throw new Error('This plan has expired. Create a new plan, then apply.')
  }
  const strangers = keys.filter((k) => !plan.keys.has(k))
  if (strangers.length)
    throw new Error(
      `Not in this plan: ${strangers.join(', ')}. Only keys the plan would add, update or review can be written.`
    )
  return plan
}
const sameKeys = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((k, i) => k === b[i])
const sameToken = (a: string, b: string): boolean => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** Still a remembered root, or the actionable error when the user removed it since the plan was made. */
function assertRemembered(store: Store, root: string): void {
  if (!store.listAllRoots().some((r) => r.path === root))
    throw new Error(
      `A source in this plan was removed from ${PRODUCT}. Add it again in the app, then plan again.`
    )
  ensureSourceRoot(store, root)
}

const methods: Record<string, Method> = {
  /**
   * Every remembered source of every workspace, scanned fresh so the agent sees
   * projects and env files by name. A source that cannot be read right now
   * (token gone, host down) is listed with its error instead of hiding the rest.
   */
  async list_sources(store) {
    const names = new Map(store.listWorkspaces().map((w) => [w.id, w.name]))
    const sources: object[] = []
    // ponytail: sequential so a provider is never hammered; parallelise per kind if this gets slow.
    for (const r of store.listAllRoots()) {
      const { path: root, ...info } = toRoot(store, r.path, r.label)
      const base = { root, ...info, workspace: names.get(r.workspaceId) ?? '' }
      try {
        ensureSourceRoot(store, r.path)
        const scan = await scanWorkspace(r.path)
        sources.push({
          ...base,
          projects: scan.projects,
          files: scan.files.map((f) => ({
            rel: f.rel,
            name: f.name,
            kind: envKind(f.name),
            project: f.project,
            modifiedAt: new Date(f.modifiedAt).toISOString()
          })),
          error: null
        })
      } catch (e) {
        sources.push({ ...base, projects: [], files: [], error: message(e) })
      }
    }
    return { sources }
  },

  /**
   * The desktop project picker for agents: two projects from any two sources,
   * paired by env-file identity. Each pair reports counts and clean/dirty; the
   * receipts stay in the app. A plan is a separate, explicit step.
   */
  async compare_projects(store, params) {
    const req = ProjectCompareRequestSchema.parse(params)
    const r = await compareProjects(store, req)
    const rel = (f: { rel: string }): string => f.rel
    return {
      left: req.left,
      right: req.right,
      pairs: r.pairs.map((p) => ({
        id: p.id,
        left: p.left.rel,
        right: p.right.rel,
        counts: p.receipt?.counts ?? null,
        clean: p.receipt?.clean ?? null,
        error: p.error
      })),
      onlyLeft: r.onlyLeft.map(rel),
      onlyRight: r.onlyRight.map(rel),
      ambiguous: r.ambiguous.map(rel)
    }
  },

  /**
   * Compare one ordered pair and remember it as a plan. The stored receipt binds
   * the exact refs and both redacted shapes; the target's mtime/version is taken
   * now, exactly as the desktop Apply dialog does, so the write can refuse a
   * target that moved. The agent gets key names and action classes.
   */
  async create_sync_plan(store, params) {
    const req = PlanRequestSchema.parse(params)
    const [left, right] = [
      await resolveFile(store, req.left.root, req.left.path),
      await resolveFile(store, req.right.root, req.right.path)
    ]
    const { receipt } = await compareGuarded(store, left.path, right.path, req.ignore)
    const actions = planSync(receipt)
    const id = randomUUID().replace(/-/g, '') + randomBytes(8).toString('base64url')
    const expiresAt = Date.now() + PLAN_TTL
    const label = (root: string): string =>
      toRoot(store, root, store.listAllRoots().find((r) => r.path === root)?.label ?? null).label
    const labels = {
      source: { label: label(req.left.root), path: left.rel },
      target: { label: label(req.right.root), path: right.rel }
    }
    plans.set(id, {
      receipt: receipt.id!,
      left: left.path,
      right: right.path,
      roots: [req.left.root, req.right.root],
      expectedMtime: right.modifiedAt,
      ...(right.version !== undefined ? { expectedVersion: right.version } : {}),
      keys: new Set(actions.filter((x) => x.op !== 'keep').map((x) => x.key)),
      expiresAt,
      used: false,
      labels
    })
    store.logEvent(
      'compare',
      { left: left.path, right: right.path, receipt: receipt.id, via: 'mcp' },
      { ...receipt.counts, clean: receipt.clean }
    )
    return {
      plan_id: id,
      source: { root: req.left.root, ...labels.source },
      target: { root: req.right.root, ...labels.target },
      actions: actions.map(({ key, op, reason }) => ({ key, op, reason })),
      counts: receipt.counts,
      clean: receipt.clean,
      expires_at: new Date(expiresAt).toISOString()
    }
  },

  /**
   * The human in the loop. The app shows a native dialog naming source, target
   * and the exact keys; only a click mints a token bound to this plan and this
   * ordered selection. An agent can ask, and ask again, but cannot answer.
   */
  async request_sync_approval(_store, params, opts) {
    const req = ApprovalRequestSchema.parse(params)
    const plan = livePlan(req.plan_id, req.keys)
    const target = parseRef(plan.right)
    const kind = target.kind === 'provider' ? target.provider : target.kind
    const consequence =
      `${req.keys.length} value${req.keys.length === 1 ? '' : 's'} will be copied from ${plan.labels.source.label} into ${plan.labels.target.label}. ` +
      `Other keys on the target are left alone. The target's current state is recorded first. ` +
      (target.kind === 'provider' || target.kind === 'vault'
        ? `This changes the live ${kind} environment; running services may need a redeploy to pick it up.`
        : 'The file is rewritten in place.')
    const prompt: ApprovalPrompt = {
      source: plan.labels.source,
      target: plan.labels.target,
      keys: req.keys,
      consequence
    }
    delete plan.approval
    let yes = false
    try {
      yes = (await opts.approve(prompt)) === true
    } catch {
      yes = false
    }
    if (!yes)
      throw new Error(
        `The user declined this sync in ${PRODUCT} (or the dialog was cancelled). Nothing was written.`
      )
    const expiresAt = Date.now() + APPROVAL_TTL
    plan.approval = { token: randomBytes(32).toString('base64url'), keys: req.keys, expiresAt }
    return {
      approval: plan.approval.token,
      keys: req.keys,
      expires_at: new Date(expiresAt).toISOString()
    }
  },

  /**
   * The one write. Takes a plan id, the approved keys and the approval token
   * the click minted; never a value, never a path. The token is consumed before
   * anything is read, so a failed write cannot be replayed. applyPlan then
   * re-reads both sides against the stored receipt and the target's
   * mtime/version, with the same file, Vault and provider safeguards as the
   * desktop Apply.
   */
  async apply_sync(store, params) {
    const req = ApplyRequestSchema.parse(params)
    const plan = livePlan(req.plan_id, req.keys)
    const approval = plan.approval
    // Every refusal names the approval so the agent asks the user again instead of guessing.
    if (!approval || !sameToken(approval.token, req.approval))
      throw new Error(
        `No valid approval for this plan. Call request_sync_approval so the user can confirm in ${PRODUCT}.`
      )
    if (Date.now() > approval.expiresAt) {
      delete plan.approval
      throw new Error('This approval has expired. Ask the user again with request_sync_approval.')
    }
    if (!sameKeys(approval.keys, req.keys))
      throw new Error(
        'This approval was given for different keys (or another order). Ask the user again with request_sync_approval for exactly these keys.'
      )
    delete plan.approval // consumed: one click, one attempt, before anything is read or written
    // Single use from here on, even when the write fails: a retry needs a fresh look at both sides.
    plan.used = true
    plans.delete(req.plan_id)
    for (const root of plan.roots) assertRemembered(store, root)
    const result = await applyPlan(store, {
      left: plan.left,
      right: plan.right,
      keys: req.keys,
      expectedMtime: plan.expectedMtime,
      ...(plan.expectedVersion !== undefined ? { expectedVersion: plan.expectedVersion } : {}),
      receipt: plan.receipt
    })
    store.logEvent(
      'apply',
      {
        left: plan.left,
        right: plan.right,
        snapshot: result.snapshot,
        receipt: plan.receipt,
        via: 'mcp'
      },
      {
        written: result.written,
        skipped: result.skipped,
        ...(result.verified !== undefined ? { verified: result.verified } : {}),
        ...(result.version ? { version: result.version } : {})
      }
    )
    return result
  }
}

function socketPath(dir: string): string {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\drift-${randomBytes(12).toString('hex')}`
    : join(dir, 'bridge.sock')
}

const reply = (socket: Socket, body: object): void => {
  socket.end(JSON.stringify(body) + '\n')
}
async function handle(
  store: Store,
  token: string,
  line: string,
  opts: BridgeOptions
): Promise<object> {
  let req: { token?: unknown; method?: unknown; params?: unknown }
  try {
    req = JSON.parse(line)
    if (!req || typeof req !== 'object') throw new Error()
  } catch {
    return { ok: false, error: 'Malformed request' }
  }
  const t = typeof req.token === 'string' ? Buffer.from(req.token) : Buffer.alloc(0)
  const want = Buffer.from(token)
  if (t.length !== want.length || !timingSafeEqual(t, want))
    return { ok: false, error: 'Not authorized' }
  const method =
    typeof req.method === 'string' && Object.hasOwn(methods, req.method)
      ? methods[req.method]
      : undefined
  if (!method) return { ok: false, error: `Unknown method ${String(req.method)}` }
  try {
    gate(store)
    return { ok: true, result: await method(store, req.params, opts) }
  } catch (e) {
    return { ok: false, error: message(e) }
  }
}

export function startBridge(store: Store, dir: string, opts: BridgeOptions): Promise<Bridge> {
  const token = randomBytes(32).toString('base64url')
  const path = socketPath(dir)
  const capFile = join(dir, CAPABILITY_FILE)
  if (process.platform !== 'win32')
    try {
      unlinkSync(path) // stale socket from a crashed run
    } catch {
      /* none */
    }
  const server: Server = createServer((socket) => {
    let buf = ''
    let done = false
    const timer = setTimeout(() => finish({ ok: false, error: 'Request timed out' }), READ_TIMEOUT)
    const finish = (body: object): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      reply(socket, body)
    }
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      buf += chunk
      if (buf.length > MAX_REQUEST) return finish({ ok: false, error: 'Request too large' })
      const nl = buf.indexOf('\n')
      if (nl === -1) return
      clearTimeout(timer)
      void handle(store, token, buf.slice(0, nl), opts).then(finish)
    })
    socket.on('end', () => {
      if (!buf.includes('\n')) finish({ ok: false, error: 'Malformed request' })
    })
    socket.on('error', () => clearTimeout(timer))
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, () => {
      if (process.platform !== 'win32') chmodSync(path, 0o600)
      const cap: Capability = { path, token }
      writeFileSync(capFile, JSON.stringify(cap), { mode: 0o600 })
      chmodSync(capFile, 0o600)
      resolve({
        path,
        close: () =>
          new Promise<void>((done) => {
            for (const f of [capFile, ...(process.platform === 'win32' ? [] : [path])])
              try {
                unlinkSync(f)
              } catch {
                /* already gone */
              }
            server.close(() => done())
          })
      })
    })
  })
}
