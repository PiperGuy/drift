import { test, vi, afterAll } from 'vitest'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Reversible safeStorage stand-in (same shape as write.test.ts) + app.getVersion.
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from('sealed:' + s),
    decryptString: (b: Buffer) => b.toString().slice('sealed:'.length)
  },
  app: { getVersion: () => '0.0.0-test' }
}))

const { openStore } = await import('../../store')
const { grantRoot } = await import('../../workspace')
const { parseRef, vaultRef, isRemote, readText, writeAtomic } = await import('../../fs')
const { registerVault, connectVault, vaultHistory, vaultShapeAt, vaultRestore, renderEnvText } =
  await import('./index')
const { applyPlan, formatFile, setValues, rollback } = await import('../../write')
const { fingerprint } = await import('../../env')
const { parseEnv } = await import('@shared/env-file')

/**
 * In-memory mock of the Vault KV v2 HTTP API on loopback. Only the endpoints
 * the adapter uses; semantics follow the official API docs (404-with-metadata
 * for deleted versions, CAS mismatch as HTTP 400 with the documented message).
 */
type Version = { data: Record<string, unknown> | null; deleted: boolean; destroyed: boolean }
const TOKEN = 'unit-test-token-not-real'
const kv = new Map<string, Version[]>()
let raceOnWrite = false

kv.set('apps/api/prod', [
  {
    data: { DATABASE_URL: 'postgres://one', STRIPE_KEY: 'sk_test_unit', flags: { beta: true } },
    deleted: false,
    destroyed: false
  }
])
kv.set('apps/api/staging', [
  { data: { DATABASE_URL: 'postgres://stage' }, deleted: false, destroyed: false }
])

const json = (res: import('node:http').ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}
const versionMeta = (n: number, v: Version): Record<string, unknown> => ({
  version: n,
  created_time: new Date(1700000000000 + n * 60_000).toISOString(),
  deletion_time: v.deleted || v.destroyed ? new Date().toISOString() : '',
  destroyed: v.destroyed,
  created_by: { actor: 'userpass-test', operation: n === 1 ? 'create' : 'update' }
})

const server: Server = createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', (c: Buffer) => chunks.push(c))
  req.on('end', () => {
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}
    const url = new URL(req.url ?? '/', 'http://x')
    const p = url.pathname
    if (p === '/v1/sys/health')
      return json(res, 200, { initialized: true, sealed: false, standby: false, version: '1.21.0' })
    if (req.headers['x-vault-token'] !== TOKEN && p !== '/v1/sys/wrapping/lookup')
      return json(res, 403, { errors: ['permission denied'] })
    if (p === '/v1/auth/token/lookup-self')
      return json(res, 200, {
        data: {
          accessor: 'acc-unit',
          display_name: 'token-unit',
          policies: ['default', 'app'],
          identity_policies: [],
          expire_time: null,
          ttl: 0,
          renewable: false,
          num_uses: 0,
          type: 'service'
        }
      })
    if (p === '/v1/sys/wrapping/lookup')
      return json(res, 400, { errors: ['wrapping token is not valid or does not exist'] })
    if (p.startsWith('/v1/sys/internal/ui/mounts/'))
      return json(res, 200, { data: { path: 'secret/', type: 'kv', options: { version: '2' } } })
    if (p === '/v1/secret/config')
      return json(res, 200, {
        data: { cas_required: false, max_versions: 0, delete_version_after: '0s' }
      })
    if (p === '/v1/sys/capabilities-self') {
      const out: Record<string, unknown> = {}
      for (const path of (body.paths as string[]) ?? [])
        out[path] = ['read', 'create', 'update', 'list']
      return json(res, 200, { data: out })
    }
    if (p.startsWith('/v1/secret/metadata/')) {
      const rel = decodeURIComponent(p.slice('/v1/secret/metadata/'.length)).replace(/\/+$/, '')
      if (url.searchParams.get('list') === 'true') {
        const keys = [...kv.keys()]
          .filter((k) => k.startsWith(rel + '/'))
          .map((k) => k.slice(rel.length + 1).split('/')[0])
        const uniq = [...new Set(keys)].map((k) =>
          [...kv.keys()].includes(`${rel}/${k}`) ? k : `${k}/`
        )
        return uniq.length
          ? json(res, 200, { data: { keys: uniq } })
          : json(res, 404, { errors: [] })
      }
      const versions = kv.get(rel)
      if (!versions) return json(res, 404, { errors: [] })
      const map: Record<string, unknown> = {}
      versions.forEach((v, i) => (map[String(i + 1)] = versionMeta(i + 1, v)))
      return json(res, 200, {
        data: {
          current_version: versions.length,
          oldest_version: 1,
          max_versions: 0,
          cas_required: false,
          delete_version_after: '0s',
          created_time: '',
          updated_time: versionMeta(versions.length, versions[versions.length - 1])['created_time'],
          custom_metadata: null,
          versions: map
        }
      })
    }
    if (p.startsWith('/v1/secret/data/')) {
      const rel = decodeURIComponent(p.slice('/v1/secret/data/'.length))
      const versions = kv.get(rel)
      if (req.method === 'GET') {
        if (!versions) return json(res, 404, { errors: [] })
        const n = url.searchParams.get('version')
          ? Number(url.searchParams.get('version'))
          : versions.length
        const v = versions[n - 1]
        if (!v) return json(res, 404, { errors: [] })
        if (v.deleted || v.destroyed)
          return json(res, 404, { data: { data: null, metadata: versionMeta(n, v) } })
        return json(res, 200, { data: { data: v.data, metadata: versionMeta(n, v) } })
      }
      if (req.method === 'POST') {
        const cas = (body.options as { cas?: number } | undefined)?.cas
        if (raceOnWrite) {
          // A concurrent writer slipped in: the caller's CAS is now stale.
          raceOnWrite = false
          versions?.push({ data: { RACED: 'yes' }, deleted: false, destroyed: false })
        }
        const now = kv.get(rel)?.length ?? 0
        if (cas === undefined || cas !== now)
          return json(res, 400, {
            errors: ['check-and-set parameter did not match the current version']
          })
        const list = kv.get(rel) ?? []
        list.push({ data: body.data as Record<string, unknown>, deleted: false, destroyed: false })
        kv.set(rel, list)
        return json(res, 200, { data: versionMeta(list.length, list[list.length - 1]) })
      }
    }
    return json(res, 404, { errors: [`unhandled ${req.method} ${p}`] })
  })
})

await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
const port = (server.address() as { port: number }).port
const ADDRESS = `http://127.0.0.1:${port}`
afterAll(() => server.close())

const dir = mkdtempSync(join(tmpdir(), 'drift-vault-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const store = openStore(join(dir, 'plumbr.db'))
afterAll(() => store.close())
registerVault(store)

test('refs: vault:// parses, joins and counts as remote', () => {
  const ref = vaultRef(3, 'team kv', 'apps/api/prod')
  assert.deepEqual(parseRef(ref), {
    kind: 'vault',
    connectionId: 3,
    mount: 'team kv',
    path: 'apps/api/prod'
  })
  assert.ok(isRemote(ref))
  assert.ok(!isRemote('/home/x/.env'))
})

test('renderEnvText: canonical, quotes when needed, hides non-string keys', () => {
  const text = renderEnvText('secret', 'apps/api/prod', 3, {
    A: 'plain',
    B: 'two words',
    EMPTY: '',
    nested: { x: 1 },
    'bad key': 'skipped'
  })
  assert.match(text, /^# vault:secret\/apps\/api\/prod @ v3/)
  assert.match(text, /\nA=plain\n/)
  assert.match(text, /\nB="two words"\n/)
  assert.match(text, /\nEMPTY=\n/)
  assert.ok(!text.includes('nested') && !text.includes('bad key'))
  assert.match(text, /2 keys not shown/)
})

let root = ''
let prodPath = ''

test('connect: preflight, folder root, sealed keychain token, scan lists leaves with versions', async () => {
  const { root: r, preflight } = await connectVault(store, {
    name: '',
    address: ADDRESS,
    path: 'secret/apps/api',
    auth: { kind: 'token', token: TOKEN },
    storage: 'keychain'
  })
  root = r.path
  assert.equal(r.kind, 'vault')
  assert.equal(r.label, 'vault:secret/apps/api')
  assert.equal(preflight.kind, 'folder')
  assert.equal(preflight.vaultVersion, '1.21.0')
  assert.equal(preflight.token.accessor, 'acc-unit')
  // The connection row exists; config carries no credential; the token is sealed.
  const conn = store.getConnection(
    parseRef(root).kind === 'vault' ? (parseRef(root) as { connectionId: number }).connectionId : -1
  )
  assert.ok(conn)
  assert.ok(!JSON.stringify(conn!.config).includes(TOKEN))
  assert.ok(conn!.secretBlob && conn!.secretBlob.toString().includes(TOKEN)) // reversible mock seal

  grantRoot(root)
  store.rememberRoot(root, r.label) // what the vaultConnect IPC handler does
  const { scanRoot } = await import('../../fs')
  const scan = await scanRoot(root)
  assert.deepEqual(
    scan.files.map((f) => [f.rel, f.version]),
    [
      ['prod', 1],
      ['staging', 1]
    ]
  )
  prodPath = scan.files[0].path
  // Redacted text: same value ⇒ same fingerprint as a local file would get.
  const text = await readText(prodPath)
  const entries = new Map(parseEnv(text).map((e) => [e.key, e.value]))
  assert.equal(entries.get('DATABASE_URL'), 'postgres://one')
  assert.equal(fingerprint('postgres://one'), fingerprint(entries.get('DATABASE_URL')!))
  assert.ok(!text.includes('flags')) // non-string key hidden from the text
})

test('apply: CAS write creates v2, carries non-string keys verbatim, verifies read-back', async () => {
  const left = join(dir, '.env')
  writeFileSync(left, 'DATABASE_URL="postgres://two"\nNEW_KEY=1\nBLANK=\n')
  grantRoot(dir)
  const r = await applyPlan(store, {
    left,
    right: prodPath,
    keys: ['DATABASE_URL', 'NEW_KEY', 'BLANK', 'NOPE'],
    expectedMtime: 0,
    expectedVersion: 1
  })
  assert.deepEqual(r.written, ['DATABASE_URL', 'NEW_KEY'])
  assert.deepEqual(r.skipped, [
    { key: 'BLANK', reason: 'blank in source' },
    { key: 'NOPE', reason: 'not in source' }
  ])
  assert.deepEqual(r.version, { base: 1, next: 2 })
  assert.equal(r.verified, true)
  const v2 = kv.get('apps/api/prod')![1].data!
  assert.equal(v2['DATABASE_URL'], 'postgres://two')
  assert.equal(v2['NEW_KEY'], '1')
  assert.equal(v2['STRIPE_KEY'], 'sk_test_unit') // untouched key carried
  assert.deepEqual(v2['flags'], { beta: true }) // non-string key carried verbatim
  assert.ok(!('BLANK' in v2))
  // Shape-only snapshot: keys in the clear, no restorable blob, and never a value.
  const snap = store.listSnapshots()[0]
  assert.equal(snap.restorable, false)
  assert.ok(snap.keys.includes('DATABASE_URL'))
  assert.ok(!JSON.stringify(store.listEvents()).includes('postgres'))
})

test('apply: stale plan version is refused before any write', async () => {
  const left = join(dir, '.env')
  await assert.rejects(
    applyPlan(store, {
      left,
      right: prodPath,
      keys: ['NEW_KEY'],
      expectedMtime: 0,
      expectedVersion: 1
    }),
    /changed since this plan was made/
  )
  assert.equal(kv.get('apps/api/prod')!.length, 2)
})

test('apply: a concurrent writer trips CAS and nothing is retried', async () => {
  const left = join(dir, '.env')
  raceOnWrite = true
  await assert.rejects(
    applyPlan(store, {
      left,
      right: prodPath,
      keys: ['NEW_KEY'],
      expectedMtime: 0,
      expectedVersion: 2
    }),
    /changed since this plan was made/
  )
  // The racer's version stands; ours was never written.
  const versions = kv.get('apps/api/prod')!
  assert.equal(versions.length, 3)
  assert.deepEqual(versions[2].data, { RACED: 'yes' })
})

test('history + shape-at + restore: v1 comes back as a new CAS-guarded version', async () => {
  const h = await vaultHistory(store, prodPath)
  assert.equal(h.currentVersion, 3)
  assert.equal(h.versions[0].version, 3)
  assert.equal(h.versions.at(-1)?.createdBy?.actor, 'userpass-test')

  const shape = await vaultShapeAt(store, prodPath, 1)
  assert.ok(
    shape.entries.some(
      (e) => e.key === 'DATABASE_URL' && e.fingerprint === fingerprint('postgres://one')
    )
  )

  const r = await vaultRestore(store, prodPath, 1, 3)
  assert.deepEqual(r.version, { base: 3, next: 4 })
  assert.equal(r.verified, true)
  assert.deepEqual(kv.get('apps/api/prod')![3].data, kv.get('apps/api/prod')![0].data)
})

test('reads of a soft-deleted current version explain themselves (404 body honoured)', async () => {
  kv.get('apps/api/staging')![0].deleted = true
  const stagingRef = prodPath.replace(/prod$/, 'staging')
  await assert.rejects(readText(stagingRef), /soft-deleted/)
  kv.get('apps/api/staging')![0].deleted = false
})

test('file-style writes are refused for vault refs', async () => {
  await assert.rejects(writeAtomic(prodPath, 'X=1\n'), /not written as files/)
  await assert.rejects(formatFile(store, prodPath, 0), /read-only here/)
  await assert.rejects(
    setValues(store, { path: prodPath, expectedMtime: 0, entries: [{ key: 'X', value: '1' }] }),
    /read-only here/
  )
  const snapId = store.listSnapshots().find((s) => s.path === prodPath)?.id
  assert.ok(snapId)
  await assert.rejects(rollback(store, snapId!), /version history/)
})

test('forget-data and workspace deletion drop vault connections with their roots', () => {
  // A second workspace with its own vault source.
  const w = store.createWorkspace('Client Y')
  store.setActiveWorkspace(w.id)
  const cid = store.addConnection('vault', 'y', { address: 'https://x' }, Buffer.from('sealed:x'))
  store.rememberRoot(vaultRef(cid, 'secret', 'apps/y'))
  assert.ok(store.getConnection(cid))
  assert.deepEqual(store.deleteWorkspace(w.id), [cid])
  assert.equal(store.getConnection(cid), null) // credential gone with the workspace
  store.setActiveWorkspace(1)

  // Forget data wipes every remaining connection too.
  const prodConn = (parseRef(root) as { connectionId: number }).connectionId
  assert.ok(store.getConnection(prodConn))
  const ids = store.forgetAll()
  assert.ok(ids.includes(prodConn))
  assert.equal(store.getConnection(prodConn), null)
})
