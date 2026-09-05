import { test, vi, afterAll } from 'vitest'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({
  safeStorage: { isEncryptionAvailable: () => false },
  app: { getVersion: () => '0.0.0-test' }
}))

const { openStore } = await import('../../store')
const { grantRoot } = await import('../../workspace')
const { readText, scanRoot, parseRef } = await import('../../fs')
const { envShape } = await import('../../env')
const { registerGithub, connectGithub } = await import('./index')
const { OPAQUE_FINGERPRINT } = await import('@shared/drift')
const sodium = (await import('libsodium-wrappers')).default
await sodium.ready
// The fake API holds the private half so it can open the sealed boxes the adapter sends.
const keypair = sodium.crypto_box_keypair()
const PUBLIC_KEY = {
  key_id: 'kid-1',
  key: sodium.to_base64(keypair.publicKey, sodium.base64_variants.ORIGINAL)
}
/** Decrypted secret values as the fake received them, keyed by scope path + name. */
const sealed = new Map<string, string>()
const varStore = new Map<string, string>()
const writes: [string, string, unknown][] = []

const TOKEN = 'github_pat_unit_not_real'
const page = (url: URL, all: unknown[]): unknown[] => {
  const per = Number(url.searchParams.get('per_page') ?? 30)
  const p = Number(url.searchParams.get('page') ?? 1)
  return all.slice((p - 1) * per, p * per)
}
// 150 repository variables force pagination at per_page=100.
const manyVars = Array.from({ length: 150 }, (_, i) => ({
  name: `VAR_${String(i).padStart(3, '0')}`,
  value: `v${i}`,
  updated_at: '2026-01-01T00:00:00Z'
}))
const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  const json = (status: number, body: unknown): void => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(body === undefined ? '' : JSON.stringify(body))
  }
  if (req.headers['authorization'] !== `Bearer ${TOKEN}`)
    return json(401, { message: 'Bad credentials' })
  const p = url.pathname
  if (p.endsWith('/secrets/public-key')) return json(200, PUBLIC_KEY)
  const secretPut = /^(.*)\/secrets\/([A-Z_0-9]+)$/.exec(p)
  const varOne = /^(.*)\/variables\/([A-Z_0-9]+)$/.exec(p)
  const varList = /^(.*)\/variables$/.exec(p)
  if (req.method === 'PUT' || req.method === 'PATCH' || req.method === 'POST') {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, string>
      writes.push([req.method!, p, body])
      if (p.includes('/environments/staging/'))
        return json(403, { message: 'Resource not accessible' })
      if (req.method === 'PUT' && secretPut) {
        if (p.startsWith('/orgs/') && !body['visibility'])
          return json(422, { message: 'visibility is required' })
        if (body['key_id'] !== PUBLIC_KEY.key_id) return json(422, { message: 'bad key_id' })
        const opened = sodium.crypto_box_seal_open(
          sodium.from_base64(body['encrypted_value'], sodium.base64_variants.ORIGINAL),
          keypair.publicKey,
          keypair.privateKey
        )
        const existed = sealed.has(`${secretPut[1]}/${secretPut[2]}`)
        sealed.set(`${secretPut[1]}/${secretPut[2]}`, sodium.to_string(opened))
        return json(existed ? 204 : 201, undefined)
      }
      if (req.method === 'PATCH' && varOne) {
        varStore.set(`${varOne[1]}/${varOne[2]}`, body['value'])
        return json(204, undefined)
      }
      if (req.method === 'POST' && varList) {
        varStore.set(`${varList[1]}/${body['name']}`, body['value'])
        return json(201, undefined)
      }
      json(404, { message: 'Not Found' })
    })
    return
  }
  if (req.method === 'GET' && secretPut && p.startsWith('/orgs/'))
    return json(200, { name: secretPut[2], visibility: 'all', updated_at: '2026-01-01T00:00:00Z' })
  if (req.method === 'GET' && secretPut)
    return sealed.has(`${secretPut[1]}/${secretPut[2]}`) || secretPut[2] === 'DATABASE_URL'
      ? json(200, { name: secretPut[2], updated_at: '2026-03-01T00:00:00Z' })
      : json(404, { message: 'Not Found' })
  if (req.method === 'GET' && varOne) {
    const v = varStore.get(`${varOne[1]}/${varOne[2]}`)
    return v === undefined
      ? json(404, { message: 'Not Found' })
      : json(200, { name: varOne[2], value: v, updated_at: '2026-03-02T00:00:00Z' })
  }
  if (p === '/repos/acme/api')
    return json(200, { id: 1, full_name: 'acme/api', permissions: { admin: true } })
  if (p === '/repos/acme/ghost') return json(404, { message: 'Not Found' })
  if (p === '/repos/acme/api/actions/secrets') {
    const extra = [...sealed.keys()]
      .filter((k) => k.startsWith('/repos/acme/api/actions/'))
      .map((k) => k.split('/').pop()!)
      .filter((n) => n !== 'STRIPE_KEY' && n !== 'DATABASE_URL')
      .map((name) => ({ name, updated_at: '2026-03-03T00:00:00Z' }))
    return json(200, {
      total_count: 2 + extra.length,
      secrets: [
        { name: 'STRIPE_KEY', updated_at: '2026-02-01T00:00:00Z' },
        { name: 'DATABASE_URL', updated_at: '2026-02-02T00:00:00Z' },
        ...extra
      ]
    })
  }
  if (p === '/repos/acme/api/actions/variables') {
    const live = manyVars.map((v) => ({
      ...v,
      value: varStore.get(`/repos/acme/api/actions/${v.name}`) ?? v.value
    }))
    return json(200, { total_count: live.length, variables: page(url, live) })
  }
  if (p === '/repos/acme/api/environments')
    return json(200, {
      total_count: 2,
      environments: [{ name: 'production' }, { name: 'staging' }]
    })
  const env = /^\/repos\/acme\/api\/environments\/([^/]+)\/(secrets|variables)$/.exec(p)
  if (env) {
    const name = decodeURIComponent(env[1])
    if (name === 'staging')
      return env[2] === 'secrets'
        ? json(403, { message: 'Resource not accessible by personal access token' })
        : json(200, { total_count: 0, variables: [] })
    return env[2] === 'secrets'
      ? json(200, {
          total_count: 1,
          secrets: [{ name: 'DATABASE_URL', updated_at: '2026-03-01T00:00:00Z' }]
        })
      : json(200, {
          total_count: 1,
          variables: [
            {
              name: 'REGION',
              value: varStore.get(`/repos/acme/api/environments/${name}/REGION`) ?? 'eu-west-1',
              updated_at: '2026-03-02T00:00:00Z'
            }
          ]
        })
  }
  if (p === '/orgs/acme') return json(200, { login: 'acme' })
  if (p === '/orgs/acme/actions/secrets')
    return json(200, {
      total_count: 1,
      secrets: [{ name: 'ORG_SECRET', visibility: 'all', updated_at: '2026-01-01T00:00:00Z' }]
    })
  if (p === '/orgs/acme/actions/variables')
    return json(200, {
      total_count: 1,
      variables: [
        {
          name: 'ORG_VAR',
          value: varStore.get('/orgs/acme/actions/ORG_VAR') ?? 'shared',
          visibility: 'all',
          updated_at: '2026-01-01T00:00:00Z'
        }
      ]
    })
  json(404, { message: 'Not Found' })
})
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
afterAll(() => server.close())

const dir = mkdtempSync(join(tmpdir(), 'drift-github-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const store = openStore(join(dir, 'plumbr.db'))
afterAll(() => store.close())
registerGithub(store)

let root = ''
test('connect repo: token kept for the session only (no keyring), config carries owner/repo only', async () => {
  const r = await connectGithub(
    store,
    { provider: 'github', name: '', token: TOKEN, owner: 'acme', repo: 'api', storage: 'keychain' },
    base
  )
  root = r.root.path
  assert.match(root, /^github:\/\/\d+\/acme\/api$/)
  assert.equal(r.root.label, 'github:acme/api')
  assert.ok(r.warnings.some((w) => /keyring/.test(w)))
  assert.ok(r.warnings.some((w) => /never returns secret values/.test(w)))
  const conn = store.getConnection((parseRef(root) as { connectionId: number }).connectionId)!
  assert.equal(conn.secretBlob, null)
  assert.ok(!JSON.stringify(conn.config).includes(TOKEN))
  grantRoot(root)
})

test('scan + read: repo file and one per environment; secrets are names only, variables carry values, pages merge', async () => {
  const scan = await scanRoot(root)
  assert.deepEqual(
    scan.files.map((f) => f.rel),
    ['.env', '.env.production', '.env.staging']
  )
  assert.equal(scan.files[0].project, 'acme/api')
  const repo = await readText(`${root}/.env`)
  assert.match(repo, /\nVAR_000=v0\n/)
  assert.match(repo, /\nVAR_149=v149\n/)
  assert.match(repo, /2 keys reported by name only/)
  const shape = await envShape(`${root}/.env`)
  assert.equal(shape.entries.length, 152)
  assert.equal(shape.entries.find((e) => e.key === 'STRIPE_KEY')?.fingerprint, OPAQUE_FINGERPRINT)
  assert.notEqual(shape.entries.find((e) => e.key === 'VAR_001')?.fingerprint, OPAQUE_FINGERPRINT)
  const prod = await readText(`${root}/.env.production`)
  assert.match(prod, /\nREGION=eu-west-1\n/)
  assert.equal(
    (await envShape(`${root}/.env.production`)).entries.find((e) => e.key === 'DATABASE_URL')
      ?.fingerprint,
    OPAQUE_FINGERPRINT
  )
  // A scope the token cannot list explains itself instead of pretending the environment is empty.
  await assert.rejects(readText(`${root}/.env.staging`), /forbidden|scope/i)
})

test('connect org: one file with org secrets (names) and variables (values)', async () => {
  const r = await connectGithub(
    store,
    { provider: 'github', name: 'Org', token: TOKEN, owner: 'acme', storage: 'session' },
    base
  )
  grantRoot(r.root.path)
  const scan = await scanRoot(r.root.path)
  assert.deepEqual(
    scan.files.map((f) => f.rel),
    ['.env']
  )
  const text = await readText(scan.files[0].path)
  assert.match(text, /\nORG_VAR=shared\n/)
  assert.match(text, /ORG_SECRET=/)
})

test('errors: bad token and unknown repo; the token never appears', async () => {
  await assert.rejects(
    connectGithub(
      store,
      {
        provider: 'github',
        name: '',
        token: 'nope-token',
        owner: 'acme',
        repo: 'api',
        storage: 'session'
      },
      base
    ),
    (e: Error) => /unauthorized/i.test(e.message) && !e.message.includes('nope-token')
  )
  await assert.rejects(
    connectGithub(
      store,
      {
        provider: 'github',
        name: '',
        token: TOKEN,
        owner: 'acme',
        repo: 'ghost',
        storage: 'session'
      },
      base
    ),
    /not found/i
  )
  assert.ok(!JSON.stringify(store.listEvents()).includes(TOKEN))
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

test('write repo: existing secrets are re-sealed with the repo public key, variables PATCHed, new keys become secrets', async () => {
  writes.length = 0
  const r = await apply(`${root}/.env`, [
    { key: 'DATABASE_URL', value: 'postgres://gh' },
    { key: 'VAR_001', value: 'v1-new' },
    { key: 'NEW_KEY', value: 'brand new' }
  ])
  assert.deepEqual(r.written, ['DATABASE_URL', 'VAR_001', 'NEW_KEY'])
  // Secrets can never be read back: the result says so instead of claiming a clean sync.
  assert.equal(r.verified, false)
  assert.match(r.note ?? '', /DATABASE_URL, NEW_KEY.*present.*value/i)
  assert.match(r.note ?? '', /VAR_001/)
  assert.deepEqual(
    writes.map(([m, p]) => [m, p]),
    [
      ['PUT', '/repos/acme/api/actions/secrets/DATABASE_URL'],
      ['PATCH', '/repos/acme/api/actions/variables/VAR_001'],
      ['PUT', '/repos/acme/api/actions/secrets/NEW_KEY']
    ]
  )
  // The fake opened the sealed boxes with its private key: the plaintext arrived intact.
  assert.equal(sealed.get('/repos/acme/api/actions/DATABASE_URL'), 'postgres://gh')
  assert.equal(sealed.get('/repos/acme/api/actions/NEW_KEY'), 'brand new')
  const put = writes[0][2] as Record<string, string>
  assert.equal(put['key_id'], 'kid-1')
  assert.ok(!put['encrypted_value'].includes('postgres'))
  assert.equal(varStore.get('/repos/acme/api/actions/VAR_001'), 'v1-new')
})

test('write repo: variables only verify by read-back', async () => {
  const r = await apply(`${root}/.env`, [{ key: 'VAR_002', value: 'two' }])
  assert.equal(r.verified, true)
})

test('write environment: scoped to the environment, secrets sealed with the environment key', async () => {
  writes.length = 0
  const r = await apply(`${root}/.env.production`, [
    { key: 'DATABASE_URL', value: 'pg-prod' },
    { key: 'REGION', value: 'us-east-1' }
  ])
  assert.deepEqual(r.written, ['DATABASE_URL', 'REGION'])
  assert.deepEqual(
    writes.map(([m, p]) => [m, p]),
    [
      ['PUT', '/repos/acme/api/environments/production/secrets/DATABASE_URL'],
      ['PATCH', '/repos/acme/api/environments/production/variables/REGION']
    ]
  )
  assert.equal(sealed.get('/repos/acme/api/environments/production/DATABASE_URL'), 'pg-prod')
  // A scope the token cannot write explains itself; nothing partial is claimed.
  await assert.rejects(
    apply(`${root}/.env.staging`, [{ key: 'X', value: '1' }]),
    /forbidden|scope/i
  )
})

test('write org: existing entries keep their visibility; new org entries are refused with guidance', async () => {
  const orgRoot = `github://${(parseRef(root) as { connectionId: number }).connectionId + 1}/acme`
  writes.length = 0
  const r = await apply(`${orgRoot}/.env`, [
    { key: 'ORG_SECRET', value: 'org-s' },
    { key: 'ORG_VAR', value: 'org-v' }
  ])
  assert.deepEqual(r.written, ['ORG_SECRET', 'ORG_VAR'])
  assert.deepEqual(
    writes.map(([m, p, b]) => [m, p, (b as Record<string, string>)['visibility']]),
    [
      ['PUT', '/orgs/acme/actions/secrets/ORG_SECRET', 'all'],
      ['PATCH', '/orgs/acme/actions/variables/ORG_VAR', undefined]
    ]
  )
  assert.equal(sealed.get('/orgs/acme/actions/ORG_SECRET'), 'org-s')
  writes.length = 0
  await assert.rejects(
    apply(`${orgRoot}/.env`, [{ key: 'BRAND_NEW', value: 'x' }]),
    /BRAND_NEW.*create it in GitHub/i
  )
  assert.equal(writes.length, 0)
})
