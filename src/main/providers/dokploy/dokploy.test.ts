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
const { envShape } = await import('../../env')
const { registerDokploy, connectDokploy } = await import('./index')

const KEY = 'dokploy-unit-key'
const base = await fakeApi((req, url, _body, json) => {
  if (req.headers['x-api-key'] !== KEY) return json(401, { message: 'Unauthorized' })
  const p = url.pathname
  if (p === '/api/project.all')
    return json(200, [
      {
        projectId: 'prj-1',
        name: 'Shop',
        // Newer Dokploy: environments hold the applications.
        environments: [
          {
            environmentId: 'env-1',
            name: 'production',
            applications: [{ applicationId: 'app-1', name: 'API', appName: 'shop-api-abc' }]
          }
        ]
      },
      // Older Dokploy: applications directly under the project.
      {
        projectId: 'prj-2',
        name: 'Blog',
        applications: [{ applicationId: 'app-2', name: 'Web', appName: 'blog-web' }]
      }
    ])
  if (p === '/api/application.one') {
    const id = url.searchParams.get('applicationId')
    if (id === 'app-1')
      return json(200, {
        applicationId: id,
        env: 'DATABASE_URL=postgres://d\n# note\nPORT=8080\n',
        buildArgs: 'X=1'
      })
    if (id === 'app-2') return json(200, { applicationId: id, env: null })
    return json(404, { message: 'Application not found' })
  }
  json(404, { message: 'not found' })
})
const store = openStore(join(tempDir('drift-dokploy-'), 'plumbr.db'))
afterAll(() => store.close())
registerDokploy(store)

let root = ''
test('connect: instance URL + key, projects counted, key never in config', async () => {
  const r = await connectDokploy(store, {
    provider: 'dokploy',
    name: '',
    token: KEY,
    address: base,
    storage: 'keychain'
  })
  root = r.root.path
  assert.equal(r.root.label, `dokploy:127.0.0.1`)
  assert.match(r.summary, /2 projects · 2 applications/)
  const conn = store.getConnection((parseRef(root) as { connectionId: number }).connectionId)!
  assert.ok(!JSON.stringify(conn.config).includes(KEY))
  assert.equal(conn.config['address'], base)
  grantRoot(root)
})

test('scan + read: both project shapes; the env text is passed through as the file', async () => {
  const scan = await scanRoot(root)
  assert.deepEqual(
    scan.files.map((f) => [f.rel, f.project]),
    [
      ['Blog/Web/.env', 'Blog/Web'],
      ['Shop/production/API/.env', 'Shop/production/API']
    ]
  )
  const text = await readText(scan.files[1].path)
  assert.match(text, /^# dokploy:.*\nDATABASE_URL=postgres:\/\/d\n# note\nPORT=8080\n$/)
  assert.deepEqual(
    (await envShape(scan.files[1].path)).entries.map((e) => e.key),
    ['DATABASE_URL', 'PORT']
  )
  assert.match(await readText(scan.files[0].path), /^# dokploy:.*\n$/)
})

test('errors: wrong key, plain http off loopback refused, unknown app', async () => {
  await assert.rejects(
    connectDokploy(store, {
      provider: 'dokploy',
      name: '',
      token: 'nope',
      address: base,
      storage: 'session'
    }),
    (e: Error) => /unauthorized/i.test(e.message) && !e.message.includes('nope')
  )
  await assert.rejects(
    connectDokploy(store, {
      provider: 'dokploy',
      name: '',
      token: KEY,
      address: 'http://dokploy.example.com',
      storage: 'session'
    }),
    /https/
  )
  await assert.rejects(readText(`${root}/app-9/.env`), /not found/i)
})
