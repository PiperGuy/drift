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
const { registerRailway, connectRailway } = await import('./index')

const TOKEN = 'railway-unit-token'
const PROJECT = { id: 'p-uuid-1', name: 'shop' }
const base = await fakeApi((req, url, body, json) => {
  if (url.pathname !== '/graphql/v2') return json(404, { message: 'nope' })
  if (req.headers['authorization'] !== `Bearer ${TOKEN}`)
    return json(200, { errors: [{ message: 'Not Authorized' }] })
  const { query, variables } = body as { query: string; variables?: Record<string, string> }
  if (/me\s*\{/.test(query))
    return json(200, { data: { me: { projects: { edges: [{ node: PROJECT }] } } } })
  if (/project\(/.test(query)) {
    if (variables?.['id'] !== PROJECT.id)
      return json(200, { errors: [{ message: 'Project not found' }] })
    return json(200, {
      data: {
        project: {
          ...PROJECT,
          environments: {
            edges: [
              { node: { id: 'env-prod', name: 'production' } },
              { node: { id: 'env-stg', name: 'staging' } }
            ]
          },
          services: { edges: [{ node: { id: 'svc-api', name: 'api' } }] }
        }
      }
    })
  }
  if (/variables\(/.test(query)) {
    const v = variables ?? {}
    if (v['environmentId'] === 'env-prod' && v['serviceId'] === 'svc-api')
      return json(200, { data: { variables: { DATABASE_URL: 'postgres://prod', PORT: '3000' } } })
    if (v['environmentId'] === 'env-prod' && !v['serviceId'])
      return json(200, { data: { variables: { SHARED: 'yes' } } })
    return json(200, { data: { variables: {} } })
  }
  json(200, { errors: [{ message: `unhandled ${query}` }] })
})
const store = openStore(join(tempDir('drift-railway-'), 'plumbr.db'))
afterAll(() => store.close())
registerRailway(store)

let root = ''
test('connect: project by name, token sealed, no credential in config', async () => {
  const r = await connectRailway(
    store,
    { provider: 'railway', name: '', token: TOKEN, project: 'shop', storage: 'keychain' },
    base
  )
  root = r.root.path
  assert.equal(
    root,
    `railway://${(parseRef(root) as { connectionId: number }).connectionId}/p-uuid-1`
  )
  assert.equal(r.root.label, 'railway:shop')
  assert.match(r.summary, /2 environments · 1 service/)
  const conn = store.getConnection((parseRef(root) as { connectionId: number }).connectionId)!
  assert.ok(!JSON.stringify(conn.config).includes(TOKEN))
  grantRoot(root)
})

test('scan + read: shared and per-service files per environment, values as a JSON map', async () => {
  const scan = await scanRoot(root)
  assert.deepEqual(
    scan.files.map((f) => [f.rel, f.project]),
    [
      ['.env.production', 'shop'],
      ['.env.staging', 'shop'],
      ['api/.env.production', 'shop/api'],
      ['api/.env.staging', 'shop/api']
    ]
  )
  const api = scan.files.find((f) => f.rel === 'api/.env.production')!
  assert.equal(api.path, `${root}/env-prod/svc-api/.env.production`)
  const text = await readText(api.path)
  assert.match(text, /\nDATABASE_URL=postgres:\/\/prod\nPORT=3000\n/)
  assert.match(await readText(scan.files[0].path), /\nSHARED=yes\n/)
  assert.equal((await statRef(api.path)).size, 0)
})

test('errors: GraphQL errors become typed messages without the token', async () => {
  await assert.rejects(
    connectRailway(
      store,
      { provider: 'railway', name: '', token: 'bad', project: 'shop', storage: 'session' },
      base
    ),
    (e: Error) => /Not Authorized|unauthorized/i.test(e.message) && !e.message.includes('bad')
  )
  await assert.rejects(
    connectRailway(
      store,
      { provider: 'railway', name: '', token: TOKEN, project: 'ghost', storage: 'session' },
      base
    ),
    /not found/i
  )
})
