import { test, vi, afterAll } from 'vitest'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { fakeApi, tempDir } from '../testkit'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from('sealed:' + s),
    decryptString: (b: Buffer) => b.toString().slice(7)
  },
  app: { getVersion: () => '0.0.0-test' }
}))
const { openStore } = await import('../../store')
const { grantRoot } = await import('../../workspace')
const { readText, scanRoot, parseRef } = await import('../../fs')
const { registerRender, connectRender } = await import('./index')

const TOKEN = 'rnd_unit_token'
// 120 services: forces two cursor pages at limit=100.
const services = Array.from({ length: 120 }, (_, i) => ({
  cursor: `c${i}`,
  service: {
    id: `srv-${i}`,
    name: `svc${i}`,
    type: 'web_service',
    updatedAt: '2026-01-02T00:00:00Z'
  }
}))
const vars = new Map<string, string>([
  ['DATABASE_URL', 'postgres://r'],
  ['EMPTY', '']
])
const groupVars = new Map<string, string>([['SENTRY_DSN', 'https://s']])
const puts: [string, unknown][] = []
const base = await fakeApi((req, url, body, json, res) => {
  if (req.headers['authorization'] !== `Bearer ${TOKEN}`)
    return json(401, { message: 'Unauthorized' })
  const p = url.pathname
  const put = /^\/v1\/(services\/srv-1|env-groups\/evg-1)\/env-vars\/([^/]+)$/.exec(p)
  if (req.method === 'PUT' && put) {
    puts.push([p, body])
    const key = put[2]
    if (key === 'SLOW') return // never answers
    if (key === 'FORBIDDEN') return json(403, { message: 'insufficient scope' })
    if (key === 'MALFORMED') {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      return res.end('<html>oops</html>')
    }
    if (key === 'RATE') {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '7' })
      return res.end('{"message":"slow down"}')
    }
    const value = (body as { value: string }).value
    // GHOST is accepted but never stored: simulates a read-back that does not confirm.
    if (key !== 'GHOST') (put[1].startsWith('services') ? vars : groupVars).set(key, value)
    return json(200, { key, value })
  }
  const limit = Number(url.searchParams.get('limit') ?? 20)
  const cursor = url.searchParams.get('cursor')
  const after = <T extends { cursor: string }>(all: T[]): T[] => {
    const i = cursor ? all.findIndex((x) => x.cursor === cursor) + 1 : 0
    return all.slice(i, i + limit)
  }
  if (p === '/v1/owners')
    return json(200, [{ cursor: 'o1', owner: { id: 'own-1', name: 'Acme', type: 'team' } }])
  if (p === '/v1/services') return json(200, after(services))
  if (p === '/v1/env-groups')
    return json(200, [
      { cursor: 'g1', envGroup: { id: 'evg-1', name: 'shared', updatedAt: '2026-01-03T00:00:00Z' } }
    ])
  if (p === '/v1/services/srv-1/env-vars')
    return json(
      200,
      cursor
        ? []
        : [...vars].map(([key, value], i) => ({ cursor: `e${i}`, envVar: { key, value } }))
    )
  if (p === '/v1/env-groups/evg-1')
    return json(200, {
      id: 'evg-1',
      name: 'shared',
      envVars: [...groupVars].map(([key, value]) => ({ key, value })),
      secretFiles: [{ name: 'creds.json' }]
    })
  json(404, { message: 'not found' })
})
const store = openStore(join(tempDir('drift-render-'), 'plumbr.db'))
afterAll(() => store.close())
registerRender(store)

let root = ''
test('connect: preflight lists owners, summary counts services and groups', async () => {
  const r = await connectRender(
    store,
    { provider: 'render', name: '', token: TOKEN, storage: 'session' },
    `${base}/v1`
  )
  root = r.root.path
  assert.match(root, /^render:\/\/\d+$/)
  assert.equal(r.root.label, 'render:Acme')
  assert.match(r.summary, /120 services · 1 env group/)
  const conn = store.getConnection((parseRef(root) as { connectionId: number }).connectionId)!
  assert.ok(!JSON.stringify(conn.config).includes(TOKEN))
  grantRoot(root)
})

test('scan + read: services (paged) and env groups as files; secret files noted, not read', async () => {
  const scan = await scanRoot(root)
  assert.equal(scan.files.length, 121)
  assert.deepEqual(scan.files[0], {
    path: `${root}/env-groups/evg-1/.env`,
    root,
    rel: 'env-groups/shared/.env',
    name: '.env',
    project: 'env-groups/shared',
    modifiedAt: Date.parse('2026-01-03T00:00:00Z'),
    size: 0
  })
  const svc = scan.files.find((f) => f.rel === 'services/svc1/.env')!
  assert.match(await readText(svc.path), /\nDATABASE_URL=postgres:\/\/r\nEMPTY=\n/)
  const group = await readText(scan.files[0].path)
  assert.match(group, /\nSENTRY_DSN=https:\/\/s\n/)
  assert.match(group, /secret file.*creds\.json/)
})

test('errors: a bad key is unauthorized and never echoed', async () => {
  await assert.rejects(
    connectRender(
      store,
      { provider: 'render', name: '', token: 'bad-key', storage: 'session' },
      `${base}/v1`
    ),
    (e: Error) => /unauthorized/i.test(e.message) && !e.message.includes('bad-key')
  )
})

// ---------- writes ----------
const { providerBackendFor } = await import('../../fs')
const { _setDefaultTimeout } = await import('../http')
const apply = (
  ref: string,
  entries: { key: string; value: string }[]
): Promise<import('../../fs').ProviderWriteResult> =>
  providerBackendFor(parseRef(ref) as import('../../fs').ProviderRef).apply!(
    parseRef(ref) as import('../../fs').ProviderRef,
    { entries, expectedMtime: 0, token: 'unit-token' }
  )

test('write: service and env-group variables are PUT one by one, then read back', async () => {
  puts.length = 0
  const r = await apply(`${root}/services/srv-1/.env`, [
    { key: 'DATABASE_URL', value: 'postgres://new' },
    { key: 'NEW_KEY', value: 'v' }
  ])
  assert.deepEqual(r.written, ['DATABASE_URL', 'NEW_KEY'])
  assert.equal(r.verified, true)
  assert.match(r.note ?? '', /redeploy/i)
  assert.deepEqual(puts, [
    ['/v1/services/srv-1/env-vars/DATABASE_URL', { value: 'postgres://new' }],
    ['/v1/services/srv-1/env-vars/NEW_KEY', { value: 'v' }]
  ])
  assert.match(await readText(`${root}/services/srv-1/.env`), /NEW_KEY=v\n/)
  puts.length = 0
  const g = await apply(`${root}/env-groups/evg-1/.env`, [
    { key: 'SENTRY_DSN', value: 'https://t' }
  ])
  assert.equal(g.verified, true)
  assert.deepEqual(puts, [['/v1/env-groups/evg-1/env-vars/SENTRY_DSN', { value: 'https://t' }]])
})

test('write: read-back mismatch is reported, never presented as a clean sync', async () => {
  const r = await apply(`${root}/services/srv-1/.env`, [{ key: 'GHOST', value: 'x' }])
  assert.deepEqual(r.written, ['GHOST'])
  assert.equal(r.verified, false)
  assert.match(r.note ?? '', /GHOST/)
})

test('write: unauthorized, malformed, rate limit and timeout fail without retry and name what was written', async () => {
  const ref = `${root}/services/srv-1/.env`
  await assert.rejects(apply(ref, [{ key: 'FORBIDDEN', value: 'x' }]), /forbidden|scope/i)
  await assert.rejects(apply(ref, [{ key: 'MALFORMED', value: 'x' }]), /not JSON|malformed/i)
  await assert.rejects(apply(ref, [{ key: 'RATE', value: 'x' }]), /rate limited/i)
  // The first key lands, the second fails: the error says so and nothing is retried.
  puts.length = 0
  await assert.rejects(
    apply(ref, [
      { key: 'OK1', value: '1' },
      { key: 'RATE', value: 'x' },
      { key: 'OK2', value: '2' }
    ]),
    /Wrote OK1, then failed on RATE.*rate limited/i
  )
  assert.equal(puts.length, 2)
  _setDefaultTimeout(200)
  puts.length = 0
  try {
    await assert.rejects(apply(ref, [{ key: 'SLOW', value: 'x' }]), /did not answer/)
  } finally {
    _setDefaultTimeout(30_000)
  }
  assert.equal(puts.length, 1)
})
