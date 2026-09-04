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
const base = await fakeApi((req, url, _body, json) => {
  if (req.headers['authorization'] !== `Bearer ${TOKEN}`)
    return json(401, { message: 'Unauthenticated.' })
  const p = url.pathname
  if (p === '/api/v1/applications')
    return json(200, [
      { uuid: 'u-api', name: 'api', updated_at: '2026-04-01T00:00:00.000000Z' },
      { uuid: 'u-web', name: 'web', updated_at: '2026-04-02T00:00:00.000000Z' }
    ])
  if (p === '/api/v1/applications/u-api/envs')
    return json(200, [
      {
        uuid: 'e1',
        key: 'DATABASE_URL',
        value: 'postgres://c',
        is_preview: false,
        is_build_time: false,
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
    ])
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
