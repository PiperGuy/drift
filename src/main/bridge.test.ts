import { test, vi, afterAll } from 'vitest'
import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import { tempDir } from './providers/testkit'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from('sealed:' + s),
    decryptString: (b: Buffer) => b.toString().slice('sealed:'.length)
  },
  app: { getVersion: () => '0.0.0-test' }
}))

const { openStore } = await import('./store')
const { startBridge } = await import('./bridge')
const { callBridge } = await import('../mcp/bridge-client')

const dir = tempDir('drift-bridge-')
const store = openStore(join(dir, 'plumbr.db'))
type Prompt = {
  source: { label: string; path: string }
  target: { label: string; path: string }
  keys: string[]
  consequence: string
}
const prompts: Prompt[] = []
let decision = true
const bridge = await startBridge(store, dir, {
  approve: async (p) => {
    prompts.push(p)
    return decision
  }
})
afterAll(async () => {
  await bridge.close()
  store.close()
})

/** Raw line over the socket, so tests can send garbage the client never would. */
const raw = (line: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const cap = JSON.parse(readFileSync(join(dir, 'bridge.json'), 'utf8')) as { path: string }
    const s = connect(cap.path)
    let out = ''
    s.on('connect', () => s.end(line))
    s.on('data', (d) => (out += d))
    s.on('end', () => resolve(out))
    s.on('error', reject)
  })

test('bridge: capability and socket are owner-only and the token is never in the launch args', () => {
  const cap = JSON.parse(readFileSync(join(dir, 'bridge.json'), 'utf8')) as {
    path: string
    token: string
  }
  assert.equal(statSync(join(dir, 'bridge.json')).mode & 0o777, 0o600)
  if (process.platform !== 'win32') assert.equal(statSync(cap.path).mode & 0o777, 0o600)
  assert.ok(cap.token.length >= 43)
  assert.ok(!process.argv.join(' ').includes(cap.token))
})

test('bridge: wrong token, malformed input and unknown methods are refused', async () => {
  const bad = JSON.parse(
    await raw(JSON.stringify({ token: 'x'.repeat(64), method: 'list_sources', params: {} }) + '\n')
  )
  assert.equal(bad.ok, false)
  assert.match(bad.error, /not authorized/i)
  const garbage = JSON.parse(await raw('{not json\n'))
  assert.equal(garbage.ok, false)
  assert.match(garbage.error, /malformed/i)
  // A request that never sends a newline is dropped, not left hanging.
  const noLine = JSON.parse(await raw('{"token":"abc"}'))
  assert.equal(noLine.ok, false)
  await assert.rejects(callBridge(dir, 'no_such_method', {}), /unknown method/i)
})

/* ---------- fixtures: two folders in two workspaces, one fake provider ---------- */
import { mkdirSync, writeFileSync } from 'node:fs'
const { registerProviderBackend, providerRef } = await import('./fs')
const { revokeRoots, isGranted } = await import('./workspace')

const a = join(dir, 'laptop')
const b = join(dir, 'server')
mkdirSync(join(a, 'api', '.git'), { recursive: true })
mkdirSync(join(b, 'svc', '.git'), { recursive: true })
writeFileSync(join(a, 'api', '.env'), 'A=1\n')
writeFileSync(
  join(a, 'api', '.env.production'),
  'DATABASE_URL=postgres://laptop-secret\nONLY_A=1\nBLANK=\n'
)
writeFileSync(join(b, 'svc', '.env.production'), 'DATABASE_URL=postgres://server-old\nONLY_B=1\n')
writeFileSync(join(b, 'svc', '.env.preview'), 'P=1\n')

// A fake platform: values and a token live only in this closure, exactly like a real adapter.
const PROVIDER_TOKEN = 'fake-provider-token-never-shown'
const cloud: Record<string, string> = { DATABASE_URL: 'postgres://cloud-old', CLOUD_ONLY: 'c' }
let cloudMtime = 1_700_000_000_000
const cloudWrites: { key: string; value: string }[] = []
let cloudLocked = false
const { NEEDS_REAUTH } = await import('./providers/connection')
registerProviderBackend('vercel', {
  readText: async () => {
    if (cloudLocked) throw new Error(NEEDS_REAUTH('vercel'))
    return (
      Object.entries(cloud)
        .map(([k, v]) => `${k}=${v}`)
        .join('\n') + '\n'
    )
  },
  stat: async () => ({ mtimeMs: cloudMtime, size: 0 }),
  scan: async (root) => ({
    root,
    files: [
      {
        path: `${root}/.env.production`,
        root,
        rel: '.env.production',
        name: '.env.production',
        project: 'web',
        modifiedAt: cloudMtime,
        size: 0
      }
    ],
    projects: ['web'],
    scannedDirs: 1,
    durationMs: 0
  }),
  apply: async (_ref, write) => {
    if (write.expectedMtime !== cloudMtime) throw new Error('target changed')
    for (const e of write.entries) {
      cloud[e.key] = e.value
      cloudWrites.push(e)
    }
    cloudMtime += 1000
    return {
      written: write.entries.map((e) => e.key),
      verified: true,
      note: `token ok: ${PROVIDER_TOKEN.length}`
    }
  }
})
const connId = store.addConnection(
  'vercel',
  'vercel:web',
  { projectName: 'web' },
  Buffer.from('sealed:' + PROVIDER_TOKEN)
)
const cloudRoot = providerRef('vercel', connId, 'prj_1')

store.rememberRoot(a, 'laptop')
const other = store.createWorkspace('other')
store.setActiveWorkspace(other.id)
store.rememberRoot(b, 'server')
store.rememberRoot(cloudRoot, 'vercel:web')
store.setActiveWorkspace(1)
revokeRoots()

/** Anything an MCP client could see must be free of these. */
const SECRETS = ['laptop-secret', 'server-old', 'cloud-old', PROVIDER_TOKEN, 'sealed:']
const clean = (v: unknown): void => {
  const s = JSON.stringify(v)
  for (const secret of SECRETS) assert.ok(!s.includes(secret), `leaked ${secret}`)
}

test('list_sources: every remembered source with workspace, kind, label and projects; no values', async () => {
  const r = (await callBridge(dir, 'list_sources', {})) as {
    sources: {
      root: string
      kind: string
      label: string
      workspace: string
      projects: string[]
      files: { rel: string; project: string | null }[]
      error: string | null
    }[]
  }
  clean(r)
  assert.deepEqual(
    r.sources.map((s) => [s.root, s.kind, s.label, s.workspace, s.projects, s.error]),
    [
      [a, 'local', 'laptop', 'Default', ['api'], null],
      [b, 'local', 'server', 'other', ['svc'], null],
      [cloudRoot, 'vercel', 'vercel:web', 'other', ['web'], null]
    ]
  )
  assert.deepEqual(
    r.sources[0].files.map((f) => f.rel),
    ['api/.env', 'api/.env.production']
  )
  // Listing grants nothing that a later request could not have granted itself.
  assert.equal(isGranted(join(dir, 'stranger')), false)
})

test('bridge: MCP switch still refuses calls, but legacy license metadata does not', async () => {
  store.setMeta('mcp_enabled', '0')
  await assert.rejects(callBridge(dir, 'list_sources', {}), /turned off/i)
  store.setMeta('mcp_enabled', '1')
  store.setMeta('trial_started_at', String(Date.now() - 30 * 86_400_000))
  store.setMeta('license_key', 'invalid legacy key')
  const sources = (await callBridge(dir, 'list_sources', {})) as { sources: unknown[] }
  assert.ok(sources.sources.length > 0)
})

test('compare_projects: different sources and project paths, pairs by identity, counts only', async () => {
  const r = (await callBridge(dir, 'compare_projects', {
    left: { root: a, project: 'api' },
    right: { root: cloudRoot, project: 'web' }
  })) as {
    pairs: {
      id: string
      left: string
      right: string
      counts: Record<string, number>
      clean: boolean
      error: string | null
    }[]
    onlyLeft: string[]
    onlyRight: string[]
    ambiguous: string[]
  }
  clean(r)
  assert.deepEqual(
    r.pairs.map((p) => [
      p.id,
      p.left,
      p.right,
      p.error,
      p.clean,
      p.counts.changed,
      p.counts.missing,
      p.counts.extra
    ]),
    [['.env.production', 'api/.env.production', '.env.production', null, false, 1, 2, 1]]
  )
  assert.deepEqual(r.onlyLeft, ['api/.env'])
  assert.deepEqual(r.onlyRight, [])
  // No plan ids, rows or fingerprints leak out of a compare: a plan is a separate, explicit step.
  assert.ok(!JSON.stringify(r).includes('"fingerprint"'))
  assert.ok(!('receipt' in r.pairs[0]))
})

test('compare_projects: a root the app never remembered is refused, even when it exists', async () => {
  const stranger = join(dir, 'stranger')
  mkdirSync(stranger, { recursive: true })
  writeFileSync(join(stranger, '.env'), 'X=1\n')
  await assert.rejects(
    callBridge(dir, 'compare_projects', {
      left: { root: a, project: 'api' },
      right: { root: stranger, project: null }
    }),
    /not a source/i
  )
  assert.equal(isGranted(stranger), false)
  await assert.rejects(
    callBridge(dir, 'compare_projects', { left: { root: a }, right: { root: b, project: 'svc' } }),
    /invalid|expected/i
  )
})

type Plan = {
  plan_id: string
  source: { root: string; label: string; path: string }
  target: { root: string; label: string; path: string }
  actions: { key: string; op: string }[]
  counts: Record<string, number>
  expires_at: string
}
const planFor = (left: string, path: string, right: string, rpath: string): Promise<Plan> =>
  callBridge(dir, 'create_sync_plan', {
    left: { root: left, path },
    right: { root: right, path: rpath },
    ignore: ['NODE_ENV']
  }) as Promise<Plan>

test('create_sync_plan: opaque id, key names and action classes only; refs are root + relative path', async () => {
  const p = await planFor(a, 'api/.env.production', cloudRoot, '.env.production')
  clean(p)
  assert.match(p.plan_id, /^[A-Za-z0-9_-]{20,}$/)
  assert.deepEqual(p.source, { root: a, label: 'laptop', path: 'api/.env.production' })
  assert.deepEqual(p.target, { root: cloudRoot, label: 'vercel:web', path: '.env.production' })
  assert.deepEqual(
    p.actions.map((x) => [x.key, x.op]),
    [
      ['BLANK', 'add'],
      ['CLOUD_ONLY', 'keep'],
      ['DATABASE_URL', 'update'],
      ['ONLY_A', 'add']
    ]
  )
  assert.equal(p.counts.changed, 1)
  assert.ok(Date.parse(p.expires_at) > Date.now())
  assert.ok(!JSON.stringify(p).includes('"fingerprint"'))
  assert.ok(!JSON.stringify(p).includes('receipt'))
})

test('create_sync_plan: no absolute paths, no traversal, no file outside the scanned source', async () => {
  const stranger = join(dir, 'stranger', '.env')
  await assert.rejects(
    planFor(a, '../stranger/.env', b, 'svc/.env.production'),
    /relative|outside/i
  )
  await assert.rejects(planFor(a, stranger, b, 'svc/.env.production'), /relative|outside/i)
  await assert.rejects(
    planFor(a, 'api/.env.production', b, '../stranger/.env'),
    /relative|outside/i
  )
  await assert.rejects(planFor(a, 'api/.env.production', b, 'svc/.env.nope'), /not an env file/i)
  await assert.rejects(
    planFor(join(dir, 'stranger'), '.env', b, 'svc/.env.production'),
    /not a source/i
  )
  assert.equal(isGranted(join(dir, 'stranger')), false)
})

import { readFileSync as rf, utimesSync } from 'node:fs'
type Applied = {
  written: string[]
  skipped: { key: string; reason: string }[]
  snapshot: number
  verified?: boolean
  note?: string
}
type Approval = { approval: string; keys: string[]; expires_at: string }
const approve = (plan_id: string, keys: string[]): Promise<Approval> =>
  callBridge(dir, 'request_sync_approval', { plan_id, keys }) as Promise<Approval>
/** The full human loop: ask the app, the (fake) user clicks, then apply with the minted token. */
const apply = async (plan_id: string, keys: string[]): Promise<Applied> => {
  const { approval } = await approve(plan_id, keys)
  return callBridge(dir, 'apply_sync', { plan_id, keys, approval }) as Promise<Applied>
}
const applyWith = (plan_id: string, keys: string[], approval: unknown): Promise<Applied> =>
  callBridge(dir, 'apply_sync', { plan_id, keys, approval }) as Promise<Applied>

test('apply_sync: provider target goes through applyPlan; values reach the platform, never the agent', async () => {
  const p = await planFor(a, 'api/.env.production', cloudRoot, '.env.production')
  // Only keys the plan would add/update/review; never an extra key, never a stranger.
  await assert.rejects(approve(p.plan_id, ['CLOUD_ONLY']), /not in this plan/i)
  await assert.rejects(approve(p.plan_id, ['NOT_A_KEY']), /not in this plan/i)
  const r = await apply(p.plan_id, ['DATABASE_URL', 'ONLY_A', 'BLANK'])
  clean(r)
  assert.deepEqual(r.written, ['DATABASE_URL', 'ONLY_A'])
  assert.deepEqual(r.skipped, [{ key: 'BLANK', reason: 'blank in source' }])
  assert.equal(r.verified, true)
  assert.equal(typeof r.snapshot, 'number')
  assert.equal(cloud['DATABASE_URL'], 'postgres://laptop-secret')
  assert.equal(cloud['CLOUD_ONLY'], 'c')
  assert.deepEqual(
    cloudWrites.map((w) => w.key),
    ['DATABASE_URL', 'ONLY_A']
  )
  // The audit trail names keys and the channel, never a value.
  const ev = store.listEvents().find((e) => e.kind === 'apply')!
  assert.equal(ev.subject['via'], 'mcp')
  clean(store.listEvents())
  // A plan is single use: the same id cannot write twice.
  await assert.rejects(apply(p.plan_id, ['DATABASE_URL']), /already used|unknown/i)
  await assert.rejects(apply('1', ['DATABASE_URL']), /unknown/i)
})

test('apply_sync: local target, extra keys kept, stale target refused, direction bound to the plan', async () => {
  const target = join(b, 'svc', '.env.production')
  const p = await planFor(a, 'api/.env.production', b, 'svc/.env.production')
  const r = await apply(p.plan_id, ['DATABASE_URL'])
  clean(r)
  assert.deepEqual(r.written, ['DATABASE_URL'])
  assert.equal(rf(target, 'utf8'), 'DATABASE_URL=postgres://laptop-secret\nONLY_B=1\n')
  assert.equal(rf(join(a, 'api', '.env.production'), 'utf8').includes('ONLY_B'), false)

  // Stale: the target moved after the plan was made.
  const p2 = await planFor(a, 'api/.env.production', b, 'svc/.env.production')
  writeFileSync(target, 'DATABASE_URL=postgres://laptop-secret\nONLY_B=2\n')
  utimesSync(target, new Date(Date.now() + 5000), new Date(Date.now() + 5000))
  await assert.rejects(apply(p2.plan_id, ['ONLY_A']), /changed since/i)
  assert.equal(rf(target, 'utf8'), 'DATABASE_URL=postgres://laptop-secret\nONLY_B=2\n')

  // The other direction is another plan: b → a writes a, and never b.
  const p3 = await planFor(b, 'svc/.env.production', a, 'api/.env.production')
  assert.deepEqual(
    p3.actions.map((x) => [x.key, x.op]),
    [
      ['BLANK', 'keep'],
      ['ONLY_A', 'keep'],
      ['ONLY_B', 'add']
    ]
  )
  const r3 = await apply(p3.plan_id, ['ONLY_B'])
  assert.deepEqual(r3.written, ['ONLY_B'])
  assert.ok(rf(join(a, 'api', '.env.production'), 'utf8').endsWith('ONLY_B=2\n'))
  assert.equal(rf(target, 'utf8'), 'DATABASE_URL=postgres://laptop-secret\nONLY_B=2\n')
})

test('apply_sync: an expired plan, a removed source and a provider without a live session all fail closed', async () => {
  const p = await planFor(a, 'api/.env.production', cloudRoot, '.env.production')
  vi.useFakeTimers({ toFake: ['Date'], now: Date.parse(p.expires_at) + 1 })
  try {
    await assert.rejects(apply(p.plan_id, ['ONLY_A']), /expired/i)
  } finally {
    vi.useRealTimers()
  }
  // Source connection removed after the plan was made: refuse, do not touch the platform.
  const p2 = await planFor(a, 'api/.env.production', cloudRoot, '.env.production')
  store.setActiveWorkspace(other.id)
  store.forgetRoot(cloudRoot)
  store.setActiveWorkspace(1)
  const before = cloudWrites.length
  await assert.rejects(apply(p2.plan_id, ['ONLY_B']), /not a source|removed/i)
  assert.equal(cloudWrites.length, before)
  store.setActiveWorkspace(other.id)
  store.rememberRoot(cloudRoot, 'vercel:web')
  store.setActiveWorkspace(1)
  // No live credential session: the adapter's own re-auth error comes back verbatim.
  cloudLocked = true
  try {
    await assert.rejects(
      planFor(a, 'api/.env.production', cloudRoot, '.env.production'),
      /sign-in again/i
    )
  } finally {
    cloudLocked = false
  }
})

/* ---------- the MCP server end to end, over the in-memory transport ---------- */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
const { createMcpServer } = await import('../mcp/server')

async function mcpClient(dbPath: string): Promise<Client> {
  const [ct, st] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0' })
  await createMcpServer(dbPath).connect(st)
  await client.connect(ct)
  return client
}
type ToolResult = { content: { type: string; text: string }[]; isError?: boolean }
const call = async (
  c: Client,
  name: string,
  args: object
): Promise<{ text: string; error: boolean }> => {
  const r = (await c.callTool({ name, arguments: args })) as ToolResult
  return { text: r.content.map((x) => x.text).join('\n'), error: r.isError === true }
}

test('mcp: sources, compare, plan and apply are tool calls; text carries names, classes and counts only', async () => {
  const c = await mcpClient(join(dir, 'plumbr.db'))
  const names = (await c.listTools()).tools.map((t) => t.name).sort()
  assert.deepEqual(names, [
    'apply_sync',
    'compare_env',
    'compare_projects',
    'create_sync_plan',
    'dry_run_plan',
    'env_status',
    'list_projects',
    'list_sources',
    'request_sync_approval'
  ])
  const sources = await call(c, 'list_sources', {})
  assert.equal(sources.error, false)
  clean(sources.text)
  assert.ok(sources.text.includes('vercel:web') && sources.text.includes('laptop'))

  const cmp = await call(c, 'compare_projects', {
    left: { root: a, project: 'api' },
    right: { root: cloudRoot, project: 'web' }
  })
  assert.equal(cmp.error, false)
  clean(cmp.text)

  const bad = await call(c, 'create_sync_plan', {
    left: { root: a, path: '../stranger/.env' },
    right: { root: cloudRoot, path: '.env.production' }
  })
  assert.equal(bad.error, true)
  assert.match(bad.text, /relative/)

  const plan = await call(c, 'create_sync_plan', {
    left: { root: a, path: 'api/.env.production' },
    right: { root: cloudRoot, path: '.env.production' }
  })
  assert.equal(plan.error, false)
  clean(plan.text)
  const { plan_id } = JSON.parse(plan.text) as { plan_id: string }
  // Apply is its own call and needs a token the app minted after the user clicked.
  const refused = await call(c, 'apply_sync', {
    plan_id,
    keys: ['ONLY_B'],
    approval: 'x'.repeat(43)
  })
  assert.equal(refused.error, true)
  const asked = await call(c, 'request_sync_approval', { plan_id, keys: ['ONLY_B'] })
  assert.equal(asked.error, false, asked.text)
  clean(asked.text)
  const { approval } = JSON.parse(asked.text) as { approval: string }
  const before = cloud['ONLY_B']
  const applied = await call(c, 'apply_sync', { plan_id, keys: ['ONLY_B'], approval })
  assert.equal(applied.error, false, applied.text)
  clean(applied.text)
  assert.ok(applied.text.includes('"ONLY_B"'))
  assert.notEqual(cloud['ONLY_B'], before)
  assert.equal(cloud['ONLY_B'], '2')
  // Values never crossed: the MCP process has no reader for provider refs at all.
  await assert.rejects(
    call(c, 'env_status', { path: '.env.production', root: cloudRoot }).then((r) => {
      if (r.error) throw new Error(r.text)
    }),
    /Unknown root|only available inside/i
  )
  await c.close()
})

test('mcp: with the app closed, source and sync tools fail closed and name the app; legacy read tools still read folders', async () => {
  const offline = tempDir('drift-mcp-offline-')
  const s2 = openStore(join(offline, 'plumbr.db'))
  s2.rememberRoot(a, 'laptop')
  s2.close()
  const c = await mcpClient(join(offline, 'plumbr.db'))
  for (const [name, args] of [
    ['list_sources', {}],
    ['compare_projects', { left: { root: a, project: 'api' }, right: { root: b, project: 'svc' } }],
    [
      'create_sync_plan',
      { left: { root: a, path: 'api/.env' }, right: { root: b, path: 'svc/.env.preview' } }
    ],
    ['request_sync_approval', { plan_id: 'x', keys: ['A'] }],
    ['apply_sync', { plan_id: 'x', keys: ['A'], approval: 'x'.repeat(43) }]
  ] as const) {
    const r = await call(c, name, args)
    assert.equal(r.error, true, name)
    assert.match(r.text, /is not running/i)
  }
  const legacy = await call(c, 'list_projects', {})
  assert.equal(legacy.error, false)
  clean(legacy.text)
  assert.ok(legacy.text.includes('api/.env.production'))
  await c.close()
})

/* ---------- P1: a human click in the app is the only thing that mints a write ---------- */

/** Append a never-synced key so each test below has something the plan will add. */
let n = 0
const fresh = (file: string, key: string): void => {
  const secret = `fresh-secret-${++n}`
  SECRETS.push(secret)
  writeFileSync(file, rf(file, 'utf8') + `${key}=${secret}\n`)
}

test('approval: the app shows the user source, target, keys and consequence; cancel fails closed', async () => {
  fresh(join(a, 'api', '.env.production'), 'P1_KEY')
  const p = await planFor(a, 'api/.env.production', cloudRoot, '.env.production')
  const before = cloudWrites.length
  // A token that was never minted, and no token at all, never write.
  await assert.rejects(applyWith(p.plan_id, ['P1_KEY'], 'x'.repeat(43)), /approval/i)
  await assert.rejects(applyWith(p.plan_id, ['P1_KEY'], undefined), /approval/i)
  assert.equal(cloudWrites.length, before)
  // The user cancels or dismisses the dialog: no token, and a later apply still has nothing.
  decision = false
  const shown = prompts.length
  await assert.rejects(approve(p.plan_id, ['P1_KEY']), /declined|cancel/i)
  assert.equal(prompts.length, shown + 1)
  assert.deepEqual(prompts[shown].source, { label: 'laptop', path: 'api/.env.production' })
  assert.deepEqual(prompts[shown].target, { label: 'vercel:web', path: '.env.production' })
  assert.deepEqual(prompts[shown].keys, ['P1_KEY'])
  assert.match(prompts[shown].consequence, /vercel:web/)
  decision = true
  await assert.rejects(applyWith(p.plan_id, ['P1_KEY'], 'x'.repeat(43)), /approval/i)
  assert.equal(cloudWrites.length, before)
  // The plan itself is still alive: a fresh click writes.
  const r = await apply(p.plan_id, ['P1_KEY'])
  assert.deepEqual(r.written, ['P1_KEY'])
})

test('approval: token is one use, bound to plan, direction and exact ordered keys, expires, never logged', async () => {
  fresh(join(a, 'api', '.env.production'), 'T2_KEY')
  fresh(join(b, 'svc', '.env.production'), 'Q_KEY')
  const p = await planFor(a, 'api/.env.production', b, 'svc/.env.production')
  const q = await planFor(b, 'svc/.env.production', a, 'api/.env.production')
  const ok = await approve(p.plan_id, ['T2_KEY', 'BLANK'])
  assert.match(ok.approval, /^[A-Za-z0-9_-]{43,}$/)
  assert.deepEqual(ok.keys, ['T2_KEY', 'BLANK'])
  assert.ok(Date.parse(ok.expires_at) > Date.now())
  assert.ok(!JSON.stringify(store.listEvents()).includes(ok.approval))
  assert.ok(!JSON.stringify(store.listSnapshots()).includes(ok.approval))
  // Wrong keys, a subset, a different order, or the other direction's plan: refused.
  await assert.rejects(
    applyWith(p.plan_id, ['T2_KEY'], ok.approval),
    /approval.*keys|keys.*approval/i
  )
  await assert.rejects(
    applyWith(p.plan_id, ['BLANK', 'T2_KEY'], ok.approval),
    /approval.*keys|keys.*approval/i
  )
  await assert.rejects(applyWith(q.plan_id, ['Q_KEY'], ok.approval), /approval/i)
  const target = join(b, 'svc', '.env.production')
  const was = rf(target, 'utf8')
  // A newer approval for the same plan replaces the old one.
  const again = await approve(p.plan_id, ['T2_KEY', 'BLANK'])
  await assert.rejects(applyWith(p.plan_id, ['T2_KEY', 'BLANK'], ok.approval), /approval/i)
  assert.equal(rf(target, 'utf8'), was)
  const r = await applyWith(p.plan_id, ['T2_KEY', 'BLANK'], again.approval)
  assert.deepEqual(r.written, ['T2_KEY'])
  await assert.rejects(
    applyWith(p.plan_id, ['T2_KEY', 'BLANK'], again.approval),
    /approval|already used/i
  )
  // Expiry.
  const p2 = await planFor(b, 'svc/.env.production', a, 'api/.env.production')
  const t = await approve(p2.plan_id, ['Q_KEY'])
  vi.useFakeTimers({ toFake: ['Date'], now: Date.parse(t.expires_at) + 1 })
  try {
    await assert.rejects(applyWith(p2.plan_id, ['Q_KEY'], t.approval), /approval.*expired|expired/i)
  } finally {
    vi.useRealTimers()
  }
})

test('approval: consumed before the write, so a failed apply cannot be replayed with the same token', async () => {
  const target = join(b, 'svc', '.env.production')
  fresh(join(a, 'api', '.env.production'), 'R_KEY')
  const p = await planFor(a, 'api/.env.production', b, 'svc/.env.production')
  const t = await approve(p.plan_id, ['R_KEY'])
  const text = rf(target, 'utf8')
  writeFileSync(target, text)
  utimesSync(target, new Date(Date.now() + 9000), new Date(Date.now() + 9000))
  await assert.rejects(applyWith(p.plan_id, ['R_KEY'], t.approval), /changed since/i)
  await assert.rejects(applyWith(p.plan_id, ['R_KEY'], t.approval), /approval|already used/i)
  assert.equal(rf(target, 'utf8'), text)
})

/* ---------- P2: duplicate keys are refused before anything is read or written ---------- */

test('duplicate keys: refused at validation, no dialog, no read, no write', async () => {
  const p = await planFor(a, 'api/.env.production', b, 'svc/.env.production')
  const target = join(b, 'svc', '.env.production')
  const text = rf(target, 'utf8')
  const shown = prompts.length
  await assert.rejects(approve(p.plan_id, ['R_KEY', 'R_KEY']), /duplicate/i)
  assert.equal(prompts.length, shown)
  const t = await approve(p.plan_id, ['R_KEY'])
  await assert.rejects(applyWith(p.plan_id, ['R_KEY', 'R_KEY'], t.approval), /duplicate/i)
  assert.equal(rf(target, 'utf8'), text)
  assert.equal(text.split('R_KEY=').length, 1)
  // Same for a platform target: the adapter sees no write at all.
  const c = await planFor(a, 'api/.env.production', cloudRoot, '.env.production')
  const before = cloudWrites.length
  await assert.rejects(approve(c.plan_id, ['R_KEY', 'R_KEY']), /duplicate/i)
  assert.equal(cloudWrites.length, before)
})
