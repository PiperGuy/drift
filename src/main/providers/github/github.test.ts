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
    res.end(JSON.stringify(body))
  }
  if (req.headers['authorization'] !== `Bearer ${TOKEN}`)
    return json(401, { message: 'Bad credentials' })
  const p = url.pathname
  if (p === '/repos/acme/api')
    return json(200, { id: 1, full_name: 'acme/api', permissions: { admin: true } })
  if (p === '/repos/acme/ghost') return json(404, { message: 'Not Found' })
  if (p === '/repos/acme/api/actions/secrets')
    return json(200, {
      total_count: 2,
      secrets: [
        { name: 'STRIPE_KEY', updated_at: '2026-02-01T00:00:00Z' },
        { name: 'DATABASE_URL', updated_at: '2026-02-02T00:00:00Z' }
      ]
    })
  if (p === '/repos/acme/api/actions/variables')
    return json(200, { total_count: manyVars.length, variables: page(url, manyVars) })
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
          variables: [{ name: 'REGION', value: 'eu-west-1', updated_at: '2026-03-02T00:00:00Z' }]
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
        { name: 'ORG_VAR', value: 'shared', visibility: 'all', updated_at: '2026-01-01T00:00:00Z' }
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
