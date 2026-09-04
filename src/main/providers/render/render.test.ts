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
const base = await fakeApi((req, url, _body, json) => {
  if (req.headers['authorization'] !== `Bearer ${TOKEN}`)
    return json(401, { message: 'Unauthorized' })
  const p = url.pathname
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
        : [
            { cursor: 'e1', envVar: { key: 'DATABASE_URL', value: 'postgres://r' } },
            { cursor: 'e2', envVar: { key: 'EMPTY', value: '' } }
          ]
    )
  if (p === '/v1/env-groups/evg-1')
    return json(200, {
      id: 'evg-1',
      name: 'shared',
      envVars: [{ key: 'SENTRY_DSN', value: 'https://s' }],
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
