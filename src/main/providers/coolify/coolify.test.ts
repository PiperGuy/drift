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
const { readText, scanRoot, statRef, parseRef } = await import('../../fs')
const { registerCoolify, connectCoolify } = await import('./index')
const { OPAQUE_VALUE } = await import('@shared/drift')

const TOKEN = 'coolify-unit-token'
type Env = Record<string, unknown> & { key: string; is_preview: boolean }
const apiEnvs: Env[] = [
  {
    uuid: 'e1',
    key: 'DATABASE_URL',
    value: 'postgres://c',
    is_preview: false,
    is_build_time: false,
    is_literal: true,
    updated_at: '2026-04-03T00:00:00.000000Z'
  },
  {
    uuid: 'e2',
    key: 'DATABASE_URL',
    value: 'postgres://preview',
    is_preview: true,
    is_build_time: false,
    updated_at: '2026-04-03T00:00:00.000000Z'
  },
  {
    uuid: 'e3',
    key: 'HIDDEN',
    value: null,
    is_preview: false,
    is_build_time: true,
    is_shown_once: true,
    updated_at: '2026-04-03T00:00:00.000000Z'
  }
]
const writes: [string, string, unknown][] = []
const base = await fakeApi((req, url, body, json) => {
  if (req.headers['authorization'] !== `Bearer ${TOKEN}`)
    return json(401, { message: 'Unauthenticated.' })
  const p = url.pathname
  if (p === '/api/v1/applications')
    return json(200, [
      { uuid: 'u-api', name: 'api', updated_at: '2026-04-01T00:00:00.000000Z' },
      { uuid: 'u-web', name: 'web', updated_at: '2026-04-02T00:00:00.000000Z' }
    ])
  if (
    p === '/api/v1/applications/u-api/envs' &&
    (req.method === 'POST' || req.method === 'PATCH')
  ) {
    const b = body as Env & { value: string }
    writes.push([req.method, b.key, b])
    if (b.key === 'BOOM') return json(422, { message: 'The key field is invalid.' })
    const found = apiEnvs.find((e) => e.key === b.key && e.is_preview === Boolean(b.is_preview))
    if (req.method === 'PATCH') {
      if (!found) return json(404, { message: 'Environment variable not found.' })
      Object.assign(found, b, { updated_at: '2026-04-04T00:00:00.000000Z' })
      // Coolify never returns a shown-once value again.
      if (found.is_shown_once) found.value = null
      return json(201, found)
    }
    if (found) return json(400, { message: 'Environment variable already exists.' })
    apiEnvs.push({
      uuid: `e${apiEnvs.length + 1}`,
      ...b,
      updated_at: '2026-04-04T00:00:00.000000Z'
    })
    return json(201, { uuid: `e${apiEnvs.length}` })
  }
  if (p === '/api/v1/applications/u-api/envs') return json(200, apiEnvs)
  if (p === '/api/v1/applications/u-web/envs') return json(200, [])
  json(404, { message: 'Not found.' })
})
const store = openStore(join(tempDir('drift-coolify-'), 'plumbr.db'))
afterAll(() => store.close())
registerCoolify(store)

let root = ''
test('connect: applications counted, token sealed, config carries the address only', async () => {
  const r = await connectCoolify(store, {
    provider: 'coolify',
    name: 'Home lab',
    token: TOKEN,
    address: base,
    storage: 'keychain'
  })
  root = r.root.path
  assert.equal(r.root.label, 'Home lab')
  assert.match(r.summary, /2 applications/)
  const conn = store.getConnection((parseRef(root) as { connectionId: number }).connectionId)!
  assert.ok(!JSON.stringify(conn.config).includes(TOKEN))
  assert.ok(conn.secretBlob?.toString().includes(TOKEN))
  grantRoot(root)
})

test('scan + read: one .env (+ .env.preview when preview vars exist) per application', async () => {
  const scan = await scanRoot(root)
  assert.deepEqual(
    scan.files.map((f) => [f.rel, f.project]),
    [
      ['api/.env', 'api'],
      ['api/.env.preview', 'api'],
      ['web/.env', 'web']
    ]
  )
  const text = await readText(scan.files[0].path)
  assert.match(text, /\nDATABASE_URL=postgres:\/\/c\n/)
  assert.ok(text.includes(`HIDDEN="${OPAQUE_VALUE}"`))
  assert.ok(!text.includes('preview'))
  assert.match(await readText(scan.files[1].path), /\nDATABASE_URL=postgres:\/\/preview\n/)
  assert.equal(
    (await statRef(scan.files[0].path)).mtimeMs,
    Date.parse('2026-04-03T00:00:00.000000Z')
  )
})

test('errors: bad token is unauthorized and never echoed; unknown app is not found', async () => {
  await assert.rejects(
    connectCoolify(store, {
      provider: 'coolify',
      name: '',
      token: 'zzz',
      address: base,
      storage: 'session'
    }),
    (e: Error) => /unauthorized/i.test(e.message) && !e.message.includes('zzz')
  )
  await assert.rejects(readText(`${root}/u-ghost/.env`), /not found/i)
})

// ---------- writes ----------
const { providerBackendFor } = await import('../../fs')
const apply = (
  ref: string,
  entries: { key: string; value: string }[],
  expectedMtime = 0
): Promise<import('../../fs').ProviderWriteResult> =>
  providerBackendFor(parseRef(ref) as import('../../fs').ProviderRef).apply!(
    parseRef(ref) as import('../../fs').ProviderRef,
    { entries, expectedMtime, token: 'unit-token' }
  )

test('write: existing keys are PATCHed keeping their flags, new keys POSTed, preview scoped by is_preview', async () => {
  writes.length = 0
  const r = await apply(
    `${root}/u-api/.env`,
    [
      { key: 'DATABASE_URL', value: 'postgres://new' },
      { key: 'NEW_KEY', value: 'n' }
    ],
    Date.parse('2026-04-03T00:00:00.000000Z')
  )
  assert.deepEqual(r.written, ['DATABASE_URL', 'NEW_KEY'])
  assert.equal(r.verified, true)
  assert.match(r.note ?? '', /redeploy/i)
  assert.deepEqual(
    writes.map(([m, k, b]) => [m, k, (b as Env).is_preview, (b as Env).is_literal]),
    [
      ['PATCH', 'DATABASE_URL', false, true],
      ['POST', 'NEW_KEY', false, undefined]
    ]
  )
  // The preview copy of DATABASE_URL was left alone; the preview file targets it explicitly.
  assert.match(await readText(`${root}/u-api/.env.preview`), /DATABASE_URL=postgres:\/\/preview\n/)
  writes.length = 0
  await apply(`${root}/u-api/.env.preview`, [{ key: 'DATABASE_URL', value: 'postgres://p2' }])
  assert.deepEqual(
    writes.map(([m, k, b]) => [m, k, (b as Env).is_preview]),
    [['PATCH', 'DATABASE_URL', true]]
  )
  assert.match(await readText(`${root}/u-api/.env`), /DATABASE_URL=postgres:\/\/new\n/)
})

test('write: a stale plan (provider timestamp moved since the scan) is refused before any write', async () => {
  writes.length = 0
  await assert.rejects(
    apply(`${root}/u-api/.env`, [{ key: 'DATABASE_URL', value: 'x' }], 1),
    /changed since/
  )
  assert.equal(writes.length, 0)
})

test('write: hidden values cannot be confirmed; provider validation errors surface with the key', async () => {
  const r = await apply(`${root}/u-api/.env`, [{ key: 'HIDDEN', value: 'h' }])
  assert.equal(r.verified, false)
  assert.match(r.note ?? '', /HIDDEN/)
  await assert.rejects(apply(`${root}/u-api/.env`, [{ key: 'BOOM', value: 'x' }]), /BOOM.*invalid/i)
})
