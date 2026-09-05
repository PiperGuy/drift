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
const app1 = {
  applicationId: 'app-1',
  env: 'DATABASE_URL=postgres://d\n# note\nPORT=8080\n',
  buildArgs: 'X=1',
  buildSecrets: null as string | null,
  createEnvFile: true
}
const saves: unknown[] = []
const base = await fakeApi((req, url, body, json) => {
  if (req.headers['x-api-key'] !== KEY) return json(401, { message: 'Unauthorized' })
  const p = url.pathname
  if (p === '/api/application.saveEnvironment' && req.method === 'POST') {
    const b = body as typeof app1
    saves.push(b)
    if (b.applicationId !== 'app-1') return json(404, { message: 'Application not found' })
    if (/BOOM=/.test(b.env ?? '')) return json(500, { message: 'Internal server error' })
    Object.assign(app1, b)
    return json(200, true)
  }
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
    if (id === 'app-1') return json(200, app1)
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

// ---------- writes ----------
const { providerBackendFor } = await import('../../fs')
const apply = (
  ref: string,
  entries: { key: string; value: string }[]
): Promise<import('../../fs').ProviderWriteResult> =>
  providerBackendFor(parseRef(ref) as import('../../fs').ProviderRef).apply!(
    parseRef(ref) as import('../../fs').ProviderRef,
    { entries, expectedMtime: 0, token: 'unit-token' }
  )

test('write: the env text is re-read, patched in place and saved with build args carried through', async () => {
  saves.length = 0
  const r = await apply(`${root}/app-1/.env`, [
    { key: 'PORT', value: '9090' },
    { key: 'NEW', value: 'two words' }
  ])
  assert.deepEqual(r.written, ['PORT', 'NEW'])
  assert.equal(r.verified, true)
  assert.match(r.note ?? '', /redeploy|deployment/i)
  assert.deepEqual(saves, [
    {
      applicationId: 'app-1',
      env: 'DATABASE_URL=postgres://d\n# note\nPORT=9090\nNEW="two words"\n',
      buildArgs: 'X=1',
      buildSecrets: null,
      createEnvFile: true
    }
  ])
  assert.match(await readText(`${root}/app-1/.env`), /PORT=9090\nNEW="two words"\n$/)
})

test('write: a failed save names the key and nothing is retried; unknown app is not found', async () => {
  saves.length = 0
  await assert.rejects(apply(`${root}/app-1/.env`, [{ key: 'BOOM', value: '1' }]), /HTTP 500/)
  assert.equal(saves.length, 1)
  await assert.rejects(apply(`${root}/app-9/.env`, [{ key: 'A', value: '1' }]), /not found/i)
})
