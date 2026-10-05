import { test, vi, afterAll } from 'vitest'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from('sealed:' + s),
    decryptString: (b: Buffer) => b.toString().slice('sealed:'.length)
  },
  app: { getVersion: () => '0.0.0-test' }
}))

const { openStore } = await import('../../store')
const { readData } = await import('./client')
const { registerVault, discoverVault, connectVault } = await import('./index')
const { discoverList, discoverMount, discoverVersions, endDiscovery, LIST_CAP } =
  await import('./discover')
const {
  VaultDiscoverListSchema,
  VaultDiscoverMountSchema,
  VaultDiscoverVersionsSchema,
  VaultSourceSpecSchema
} = await import('@shared/ipc')

/**
 * Mock Vault for Browse Vault. Two tokens: an admin-capable one that may read
 * sys/mounts, and a scoped one that may not enumerate mounts and is denied one
 * branch of the tree. Every request path is logged so the test can prove that
 * discovery never touches /data/ (no secret values are fetched).
 */
const ROOT = 'unit-admin-token-not-real'
const SCOPED = 'unit-scoped-token-not-real'
const HUGE = 'unit-huge-answer-token-not-real'
const VALUE = 'sk_live_value_never_listed'
const secretsByPath = new Map<string, number>([
  ['apps/api/prod', 3],
  ['apps/api/staging', 1],
  ['apps/web/prod', 2],
  ['team/payments/billing/prod', 1],
  ['ops/locked/db', 1],
  ['top-level', 1]
])
for (let i = 0; i < LIST_CAP + 5; i++) secretsByPath.set(`bulk/s${String(i).padStart(4, '0')}`, 1)
// Secrets on the nested teams/payments mount (paths relative to that mount).
const nested = new Map<string, number>([
  ['billing/prod', 2],
  ['billing/staging', 1]
])
const requests: string[] = []
let approleLogins = 0

const json = (res: import('node:http').ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}
const MOUNTS = {
  'secret/': { type: 'kv', options: { version: '2' }, description: 'apps' },
  'kv-team/': { type: 'kv', options: { version: '2' }, description: '' },
  // Nested KV v2 mount: valid, must be enumerated and browsable.
  'teams/payments/': { type: 'kv', options: { version: '2' }, description: 'payments team' },
  // Hostile mount names from the server: dropped, never offered for browsing.
  'teams/../sys/': { type: 'kv', options: { version: '2' }, description: '' },
  'a//b/': { type: 'kv', options: { version: '2' }, description: '' },
  'ctl\u0001/': { type: 'kv', options: { version: '2' }, description: '' },
  'legacy/': { type: 'kv', options: { version: '1' }, description: '' },
  'transit/': { type: 'transit', options: null, description: '' },
  'sys/': { type: 'system', options: null, description: '' },
  'cubbyhole/': { type: 'cubbyhole', options: null, description: '' }
}

const server: Server = createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', (c: Buffer) => chunks.push(c))
  req.on('end', () => {
    const url = new URL(req.url ?? '/', 'http://x')
    const p = url.pathname
    requests.push(`${req.method} ${p}${url.search}`)
    if (p === '/v1/sys/health')
      return json(res, 200, { initialized: true, sealed: false, standby: false, version: '1.21.0' })
    if (p === '/v1/auth/approle/login') {
      approleLogins += 1
      return json(res, 200, { auth: { client_token: SCOPED } })
    }
    const tok = req.headers['x-vault-token']
    // Sign-in answers are capped: a lookup-self past 1 MiB is cut off.
    if (tok === HUGE && p === '/v1/auth/token/lookup-self')
      return json(res, 200, { data: { pad: 'x'.repeat(2 * 1024 * 1024) } })
    if (tok !== ROOT && tok !== SCOPED && p !== '/v1/sys/wrapping/lookup')
      return json(res, 403, { errors: ['permission denied'] })
    if (p === '/v1/sys/wrapping/lookup') return json(res, 400, { errors: ['not a wrapping token'] })
    if (p === '/v1/auth/token/lookup-self')
      return json(res, 200, {
        data: {
          accessor: tok === ROOT ? 'acc-root' : 'acc-scoped',
          display_name: 'unit',
          policies: tok === ROOT ? ['root'] : ['default', 'apps-read'],
          expire_time: null,
          type: 'service'
        }
      })
    if (p === '/v1/sys/mounts' || p === '/v1/sys/internal/ui/mounts')
      return tok === ROOT
        ? json(res, 200, { ...MOUNTS, data: MOUNTS })
        : json(res, 403, { errors: ['permission denied'] })
    // KV v2 mount `team-kv` whose config the scoped token may not read, holding a
    // secret named "config": its metadata carries the same fields as mount config.
    if (p === '/v1/team-kv/config') return json(res, 403, { errors: ['permission denied'] })
    if (p === '/v1/team-kv/metadata/config')
      return json(res, 200, {
        data: {
          max_versions: 0,
          cas_required: false,
          delete_version_after: '0s',
          current_version: 1,
          oldest_version: 1,
          versions: { '1': { created_time: '', deletion_time: '', destroyed: false } }
        }
      })
    // A secret with an enormous version history: its metadata is cut off, not buffered.
    if (p === '/v1/secret/metadata/apps/huge-history') {
      const versions: Record<string, unknown> = {}
      for (let v = 1; v <= 60_000; v++)
        versions[v] = {
          created_time: new Date(0).toISOString(),
          deletion_time: '',
          destroyed: false
        }
      return json(res, 200, {
        data: { current_version: 60_000, oldest_version: 1, max_versions: 0, versions }
      })
    }
    // An oversized probe answer is cut off instead of buffered.
    if (p.startsWith('/v1/sys/internal/ui/mounts/huge'))
      return json(res, 200, { data: { pad: 'x'.repeat(5 * 1024 * 1024) } })
    // Vault's own mount table for one path. The scoped token is refused it on the
    // KV v1 `legacy` and the KV v2 `team-kv` mounts (and anything unknown).
    if (p.startsWith('/v1/sys/internal/ui/mounts/')) {
      const full = decodeURIComponent(p.slice('/v1/sys/internal/ui/mounts/'.length))
      const table: Record<string, { type: string; options: unknown }> = {
        ...MOUNTS,
        'team-kv/': { type: 'kv', options: { version: '2' } }
      }
      const hit = Object.keys(table)
        .filter((k) => `${full}/`.startsWith(k))
        .sort((a, b) => b.length - a.length)[0]
      const refused = tok === SCOPED && (full.startsWith('legacy') || full.startsWith('team-kv'))
      return hit && !refused
        ? json(res, 200, { data: { path: hit, ...table[hit] } })
        : json(res, 403, { errors: ['permission denied'] })
    }
    // Like most scoped policies, the constrained token may not read mount config.
    if (p === '/v1/teams/payments/config')
      return tok === ROOT
        ? json(res, 200, {
            data: { max_versions: 0, cas_required: false, delete_version_after: '0s' }
          })
        : json(res, 403, { errors: ['permission denied'] })
    if (p === '/v1/secret/config')
      return json(res, 200, {
        data: { max_versions: 0, cas_required: false, delete_version_after: '0s' }
      })
    // KV v1 mount `legacy`: its "config" and "metadata/..." are ordinary secrets that
    // half-resemble KV v2 answers. Mount probing must not mistake them for KV v2.
    if (p === '/v1/legacy/config') return json(res, 200, { data: { max_versions: 3 } })
    if (p === '/v1/legacy/metadata/x' && url.searchParams.get('list') === 'true')
      return json(res, 200, { data: { keys: ['y'] } })
    if (p === '/v1/legacy/metadata/x/y')
      return json(res, 200, { data: { current_version: 1, versions: 'look-alike' } })
    if (p.startsWith('/v1/legacy/')) return json(res, 200, { data: { KEY: VALUE } })
    if (p === '/v1/sys/capabilities-self') return json(res, 200, { data: {} })
    // A large secret (5 MiB): bigger than the discovery and sign-in caps.
    if (p === '/v1/secret/data/big-blob')
      return json(res, 200, {
        data: { data: { BLOB: 'b'.repeat(5 * 1024 * 1024) }, metadata: { version: 1 } }
      })
    if (p.includes('/data/')) return json(res, 200, { data: { data: { KEY: VALUE } } })
    const m = /^\/v1\/(secret|teams\/payments)\/metadata\/?(.*)$/.exec(p)
    if (m) {
      const secrets = m[1] === 'secret' ? secretsByPath : nested
      const rel = decodeURIComponent(m[2]).replace(/\/+$/, '')
      if (tok === SCOPED && rel.startsWith('ops/locked'))
        return json(res, 403, { errors: ['1 error occurred:\n\t* permission denied\n\n'] })
      if (url.searchParams.get('list') === 'true') {
        const prefix = rel ? rel + '/' : ''
        const keys = new Set<string>()
        for (const k of secrets.keys())
          if (k.startsWith(prefix)) {
            const rest = k.slice(prefix.length).split('/')
            keys.add(rest.length > 1 ? rest[0] + '/' : rest[0])
          }
        // Hostile names from the server are dropped, not rendered.
        if (rel === 'apps') keys.add('../escape').add('bad\u0007bell')
        return keys.size
          ? json(res, 200, { data: { keys: [...keys] } })
          : json(res, 404, { errors: [] })
      }
      const n = secrets.get(rel)
      if (!n) return json(res, 404, { errors: [] })
      const versions: Record<string, unknown> = {}
      for (let v = 1; v <= n; v++)
        versions[v] = {
          created_time: new Date(1_700_000_000_000 + v * 60_000).toISOString(),
          deletion_time: v === 1 && n > 1 ? new Date(1_700_000_900_000).toISOString() : '',
          destroyed: v === 2 && n > 2
        }
      return json(res, 200, {
        data: {
          current_version: n,
          oldest_version: 1,
          max_versions: 0,
          updated_time: '',
          created_time: '',
          custom_metadata: { owner: 'team-a' },
          versions
        }
      })
    }
    return json(res, 404, { errors: [`unhandled ${req.method} ${p}`] })
  })
})
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
const ADDRESS = `http://127.0.0.1:${(server.address() as { port: number }).port}`
afterAll(() => server.close())

const dir = mkdtempSync(join(tmpdir(), 'drift-vault-discover-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const store = openStore(join(dir, 'plumbr.db'))
afterAll(() => store.close())
registerVault(store)

const noLeak = (x: unknown): void => {
  const s = JSON.stringify(x)
  for (const secret of [ROOT, SCOPED, VALUE]) assert.ok(!s.includes(secret), 'leaked ' + secret)
}

test('admin token: lists KV v2 mounts only, explains the rest, never returns the token', async () => {
  const d = await discoverVault({ address: ADDRESS, auth: { kind: 'token', token: ROOT } })
  assert.deepEqual(
    d.mounts?.map((m) => m.path),
    ['kv-team', 'secret', 'teams/payments']
  )
  assert.match(d.mountsNote ?? '', /2 other mounts .*KV v2 only/) // legacy (v1) + transit; sys hidden
  assert.ok(d.warnings.some((w) => /ROOT token/.test(w)))
  assert.match(d.session, /^[0-9a-f-]{36}$/)
  noLeak(d)
  endDiscovery(d.session)
})

test('nested KV v2 mount: enumerated, listed lazily, versions, typed path and connect', async () => {
  requests.length = 0
  const d = await discoverVault({ address: ADDRESS, auth: { kind: 'token', token: ROOT } })
  assert.deepEqual(
    d.mounts?.find((m) => m.path === 'teams/payments'),
    {
      path: 'teams/payments',
      description: 'payments team'
    }
  )
  const top = await discoverList(d.session, 'teams/payments', '')
  assert.deepEqual(top.state === 'ok' && top.nodes.map((n) => `${n.kind}:${n.path}`), [
    'folder:billing'
  ])
  const billing = await discoverList(d.session, 'teams/payments', 'billing')
  assert.deepEqual(billing.state === 'ok' && billing.nodes.map((n) => n.path), [
    'billing/prod',
    'billing/staging'
  ])
  // The nested mount is kept whole in the request path, never re-split.
  assert.ok(requests.includes('GET /v1/teams/payments/metadata/billing?list=true'))
  const h = await discoverVersions(d.session, 'teams/payments', 'billing/prod')
  assert.equal(h.path, 'teams/payments/billing/prod')
  assert.equal(h.currentVersion, 2)
  assert.deepEqual(await discoverMount(d.session, 'teams/payments/billing'), {
    mount: { path: 'teams/payments', description: '' },
    folder: 'billing',
    secret: false
  })
  const { root } = await connectVault(store, {
    name: '',
    address: ADDRESS,
    path: 'teams/payments/billing/prod',
    auth: { kind: 'session', session: d.session },
    storage: 'session'
  })
  assert.equal(root.label, 'vault:teams/payments/billing/prod')
  // Browsing and the connect preflight are metadata-only: no secret data was read.
  assert.ok(!requests.some((r) => r.includes('/data/')))
  endDiscovery(d.session)
})

test('constrained token: typed nested-mount paths resolve through the mount table only', async () => {
  const d = await discoverVault({
    address: ADDRESS,
    auth: { kind: 'approle', roleId: 'role', secretId: 'secret-id-not-real' }
  })
  assert.equal(d.mounts, null)
  requests.length = 0
  assert.deepEqual(await discoverMount(d.session, 'teams/payments/billing'), {
    mount: { path: 'teams/payments', description: '' },
    folder: 'billing',
    secret: false
  })
  // The mount table first; only then one metadata read on the confirmed KV v2 mount.
  assert.deepEqual(requests, [
    'GET /v1/sys/internal/ui/mounts/teams/payments/billing',
    'GET /v1/teams/payments/metadata/billing'
  ])
  // A secret: the mount is confirmed KV v2 first, then one metadata read.
  assert.deepEqual(await discoverMount(d.session, 'teams/payments/billing/prod'), {
    mount: { path: 'teams/payments', description: '' },
    folder: 'billing/prod',
    secret: true // a typed secret path is reported as a secret, not a folder
  })
  assert.deepEqual(await discoverMount(d.session, 'teams/payments'), {
    mount: { path: 'teams/payments', description: '' },
    folder: '',
    secret: false
  })
  const top = await discoverList(d.session, 'teams/payments', 'billing')
  assert.deepEqual(top.state === 'ok' && top.nodes.map((n) => n.path), [
    'billing/prod',
    'billing/staging'
  ])
  const { root, preflight } = await connectVault(store, {
    name: '',
    address: ADDRESS,
    path: 'teams/payments/billing/prod',
    auth: { kind: 'session', session: d.session },
    storage: 'session'
  })
  assert.equal(root.label, 'vault:teams/payments/billing/prod')
  assert.equal(preflight.mount, 'teams/payments')
  assert.equal(preflight.kind, 'leaf')
  assert.ok(!requests.some((r) => r.includes('/data/')))
  endDiscovery(d.session)
})

test('mount lookup refused: a typed path fails closed, nothing is sent to candidate mounts', async () => {
  const c = await discoverVault({
    address: ADDRESS,
    auth: { kind: 'approle', roleId: 'role', secretId: 'secret-id-not-real' }
  })
  // legacy is KV v1: its `config` and `metadata/...` are ordinary secrets holding VALUE.
  for (const path of [
    'legacy',
    'legacy/x',
    'legacy/x/y',
    'team-kv/apps',
    'team-kv/metadata/apps/x'
  ]) {
    requests.length = 0
    await assert.rejects(
      discoverMount(c.session, path),
      (e: Error) => /Vault would not say which mount/.test(e.message) && !e.message.includes(VALUE),
      path
    )
    // Only the mount table was asked: no /config, /metadata or /data on any candidate.
    assert.deepEqual(requests, [`GET /v1/sys/internal/ui/mounts/${path}`], path)
  }
  await assert.rejects(discoverList(c.session, 'legacy', ''), /not a KV v2 mount/)
  await assert.rejects(discoverList(c.session, 'team-kv', ''), /not a KV v2 mount/)
  endDiscovery(c.session)

  // When the mount table names a KV v1 mount, it is refused without touching it.
  const d = await discoverVault({ address: ADDRESS, auth: { kind: 'token', token: ROOT } })
  requests.length = 0
  await assert.rejects(discoverMount(d.session, 'legacy/x'), /KV version 1 mount/)
  assert.deepEqual(requests, ['GET /v1/sys/internal/ui/mounts/legacy/x'])
  await assert.rejects(discoverMount(d.session, 'huge/x'), /more data than Drift reads/)
  endDiscovery(d.session)
})

test('browse calls only reach mounts the session confirmed as KV v2', async () => {
  const d = await discoverVault({ address: ADDRESS, auth: { kind: 'token', token: ROOT } })
  requests.length = 0
  // A crafted nested "mount" ending in data/ would turn a metadata read into a data read.
  await assert.rejects(
    discoverVersions(d.session, 'secret/data', 'x'),
    /not a KV v2 mount in this browse session/
  )
  await assert.rejects(discoverList(d.session, 'secret/metadata', ''), /not a KV v2 mount/)
  // A KV v1 mount is never browsed: its "metadata" paths are secret values.
  await assert.rejects(discoverVersions(d.session, 'legacy', 'x'), /not a KV v2 mount/)
  await assert.rejects(discoverList(d.session, 'cubbyhole', ''), /not a KV v2 mount/)
  assert.deepEqual(requests, []) // refused before any request reached Vault
  endDiscovery(d.session)

  // A constrained token's typed mount is allowed only once it resolves as KV v2.
  const c = await discoverVault({
    address: ADDRESS,
    auth: { kind: 'approle', roleId: 'role', secretId: 'secret-id-not-real' }
  })
  await assert.rejects(discoverList(c.session, 'teams/payments', ''), /Open it by path first/)
  await discoverMount(c.session, 'teams/payments/billing')
  assert.equal((await discoverList(c.session, 'teams/payments', '')).state, 'ok')
  endDiscovery(c.session)
})

test('lazy tree: one level per call, folders first, nested apps, hostile names dropped', async () => {
  requests.length = 0
  const { session } = await discoverVault({
    address: ADDRESS,
    auth: { kind: 'token', token: ROOT }
  })
  const top = await discoverList(session, 'secret', '')
  assert.equal(top.state, 'ok')
  assert.deepEqual(top.state === 'ok' && top.nodes.map((n) => `${n.kind}:${n.path}`), [
    'folder:apps',
    'folder:bulk',
    'folder:ops',
    'folder:team',
    'secret:top-level'
  ])
  const apps = await discoverList(session, 'secret', 'apps')
  assert.deepEqual(apps.state === 'ok' && apps.nodes.map((n) => n.path), ['apps/api', 'apps/web'])
  const api = await discoverList(session, 'secret', 'apps/api')
  assert.deepEqual(api.state === 'ok' && api.nodes.map((n) => `${n.kind}:${n.path}`), [
    'secret:apps/api/prod',
    'secret:apps/api/staging'
  ])
  const deep = await discoverList(session, 'secret', 'team/payments/billing')
  assert.deepEqual(deep.state === 'ok' && deep.nodes.map((n) => n.name), ['prod'])
  // Only metadata LISTs were sent: nothing was prefetched below what was asked for.
  assert.equal(requests.filter((r) => r.includes('?list=true')).length, 4)
  assert.ok(!requests.some((r) => r.includes('/data/')))
  endDiscovery(session)
})

test('bounded: a huge folder is capped and flagged as truncated', async () => {
  const { session } = await discoverVault({
    address: ADDRESS,
    auth: { kind: 'token', token: ROOT }
  })
  const bulk = await discoverList(session, 'secret', 'bulk')
  assert.ok(bulk.state === 'ok' && bulk.nodes.length === LIST_CAP && bulk.truncated)
  const empty = await discoverList(session, 'secret', 'nothing/here')
  assert.equal(empty.state, 'empty')
  endDiscovery(session)
})

test('constrained token: no mount enumeration, typed mount works, denied branch is labelled', async () => {
  // AppRole: the secret_id is spent once at sign-in, never again for the connect.
  approleLogins = 0
  const d = await discoverVault({
    address: ADDRESS,
    auth: { kind: 'approle', roleId: 'role', secretId: 'secret-id-not-real' }
  })
  assert.equal(d.mounts, null)
  assert.match(d.mountsNote ?? '', /may not list mounts.*sys\/mounts/)
  const m = await discoverMount(d.session, 'secret/apps')
  assert.deepEqual(m, { mount: { path: 'secret', description: '' }, folder: 'apps', secret: false })
  await assert.rejects(discoverMount(d.session, 'legacy/x'), /Vault would not say which mount/)

  const top = await discoverList(d.session, 'secret', '')
  assert.equal(top.state, 'ok') // siblings stay browsable …
  const locked = await discoverList(d.session, 'secret', 'ops/locked')
  assert.deepEqual(locked, {
    state: 'error',
    denied: true,
    message:
      'No list permission on secret/metadata/ops/locked. Siblings you can list are unaffected.'
  })
  const ok = await discoverList(d.session, 'secret', 'apps/web')
  assert.equal(ok.state, 'ok') // … and so do other branches after the failure.

  // Picking a leaf connects it as a normal source with the session's token.
  const { root, preflight } = await connectVault(store, {
    name: '',
    address: 'https://ignored.example', // the session pins the server it signed in to
    path: 'secret/apps/web/prod',
    auth: { kind: 'session', session: d.session },
    storage: 'keychain'
  })
  assert.equal(approleLogins, 1)
  assert.equal(root.label, 'vault:secret/apps/web/prod')
  assert.equal(preflight.kind, 'leaf')
  const conn = store.getConnection(Number(/^vault:\/\/(\d+)\//.exec(root.path)![1]))!
  assert.equal((conn.config as { authKind: string }).authKind, 'approle')
  assert.equal((conn.config as { address: string }).address, ADDRESS)
  assert.ok(!JSON.stringify(conn.config).includes(SCOPED))
  endDiscovery(d.session)
})

test('versions while browsing: metadata timeline only, no values or custom metadata', async () => {
  requests.length = 0
  const { session } = await discoverVault({
    address: ADDRESS,
    auth: { kind: 'token', token: ROOT }
  })
  const h = await discoverVersions(session, 'secret', 'apps/api/prod')
  assert.equal(h.path, 'secret/apps/api/prod')
  assert.equal(h.currentVersion, 3)
  assert.deepEqual(
    h.versions.map((v) => [v.version, Boolean(v.deletionTime), v.destroyed]),
    [
      [3, false, false],
      [2, false, true],
      [1, true, false]
    ]
  )
  assert.ok(!JSON.stringify(h).includes('team-a'))
  assert.ok(!requests.some((r) => r.includes('/data/')))
  noLeak(h)
  endDiscovery(session)
})

test('versions while browsing are size-capped: a huge history is refused, not buffered', async () => {
  const { session } = await discoverVault({
    address: ADDRESS,
    auth: { kind: 'token', token: ROOT }
  })
  await assert.rejects(
    discoverVersions(session, 'secret', 'apps/huge-history'),
    /more data than Drift reads in one response/
  )
  // Normal histories are unaffected by the cap.
  assert.equal((await discoverVersions(session, 'secret', 'apps/api/prod')).currentVersion, 3)
  endDiscovery(session)
})

test('sign-in responses are size-capped and the error never carries the token', async () => {
  await assert.rejects(
    discoverVault({ address: ADDRESS, auth: { kind: 'token', token: HUGE } }),
    (e: Error) =>
      /more data than Drift reads in one response/.test(e.message) && !e.message.includes(HUGE)
  )
})

test('connected KV data reads are not held to the discovery or sign-in caps', async () => {
  // 5 MiB is past both caps (4 MiB, 1 MiB); a secret Vault accepted must still read.
  const r = await readData(
    { address: ADDRESS, token: ROOT, userAgent: 'drift-test' },
    'secret',
    'big-blob'
  )
  assert.equal(r.kind, 'ok')
  assert.equal(r.kind === 'ok' && (r.data['BLOB'] as string).length, 5 * 1024 * 1024)
})

test('ended or unknown sessions are refused; trust-boundary schemas reject traversal', async () => {
  const { session } = await discoverVault({
    address: ADDRESS,
    auth: { kind: 'token', token: ROOT }
  })
  endDiscovery(session)
  await assert.rejects(discoverList(session, 'secret', ''), /session has ended/)
  await assert.rejects(
    connectVault(store, {
      name: '',
      address: ADDRESS,
      path: 'secret/apps/api/prod',
      auth: { kind: 'session', session },
      storage: 'session'
    }),
    /session has ended/
  )
  const id = '00000000-0000-4000-8000-000000000000'
  assert.ok(
    !VaultDiscoverListSchema.safeParse({ session: id, mount: 'secret', folder: '../sys' }).success
  )
  assert.ok(
    !VaultDiscoverListSchema.safeParse({ session: id, mount: 'secret', folder: 'a//b' }).success
  )
  assert.ok(
    !VaultDiscoverListSchema.safeParse({ session: 'nope', mount: 'secret', folder: '' }).success
  )
  assert.deepEqual(
    VaultDiscoverListSchema.parse({ session: id, mount: '/secret/', folder: 'apps/' }),
    { session: id, mount: 'secret', folder: 'apps' }
  )
  // Nested mounts are valid at the boundary …
  assert.deepEqual(
    VaultDiscoverListSchema.parse({ session: id, mount: 'teams/payments/', folder: '' }),
    { session: id, mount: 'teams/payments', folder: '' }
  )
  assert.ok(
    VaultDiscoverVersionsSchema.safeParse({
      session: id,
      mount: 'teams/payments',
      path: 'billing/prod'
    }).success
  )
  // … but traversal, empty segments, control characters, empty or oversized mounts are not.
  for (const mount of [
    'teams/../sys',
    'teams//payments',
    '..',
    '.',
    '',
    '/',
    'ctl\u0001',
    'x'.repeat(257)
  ])
    assert.ok(
      !VaultDiscoverListSchema.safeParse({ session: id, mount, folder: '' }).success,
      JSON.stringify(mount)
    )
  for (const path of ['../x', 'billing/../../sys', 'a/./b', '', 'tab\tname'])
    assert.ok(
      !VaultDiscoverVersionsSchema.safeParse({ session: id, mount: 'teams/payments', path })
        .success,
      JSON.stringify(path)
    )
  assert.ok(
    !VaultDiscoverMountSchema.safeParse({ session: id, path: 'teams/payments/../../sys' }).success
  )
  assert.ok(
    !VaultSourceSpecSchema.safeParse({
      address: ADDRESS,
      path: 'secret/../sys/raw',
      auth: { kind: 'token', token: 'x' },
      storage: 'session'
    }).success
  )
})
