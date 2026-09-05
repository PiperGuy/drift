import { test, vi, afterAll } from 'vitest'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
const { readText, scanRoot, statRef, parseRef } = await import('../../fs')
const { envShape } = await import('../../env')
const { applyPlan } = await import('../../write')
const { registerVercel, connectVercel } = await import('./index')
const { OPAQUE_FINGERPRINT, OPAQUE_VALUE } = await import('@shared/drift')

const TOKEN = 'vercel-unit-token-not-real'
type V = {
  id: string
  key: string
  value?: string
  type: string
  target: string[]
  gitBranch?: string
  updatedAt: number
}
const writes: [string, string, unknown][] = []
let nextId = 100
const envs: V[] = [
  {
    id: 'e1',
    key: 'DATABASE_URL',
    value: 'postgres://prod',
    type: 'encrypted',
    target: ['production'],
    updatedAt: 1700000000000
  },
  {
    id: 'e2',
    key: 'STRIPE_KEY',
    type: 'sensitive',
    target: ['production', 'preview'],
    updatedAt: 1700000100000
  },
  {
    id: 'e3',
    key: 'NEXT_PUBLIC_URL',
    value: 'https://dev.local',
    type: 'plain',
    target: ['development'],
    updatedAt: 1
  },
  {
    id: 'e4',
    key: 'FEATURE',
    value: 'branchy',
    type: 'encrypted',
    target: ['preview'],
    gitBranch: 'feature/x',
    updatedAt: 2
  },
  { id: 'e5', key: 'bad key', value: 'nope', type: 'plain', target: ['production'], updatedAt: 3 },
  {
    id: 'e6',
    key: 'VERCEL_URL',
    value: '',
    type: 'system',
    target: ['production', 'preview', 'development'],
    updatedAt: 4
  }
]
let seenQueries: string[] = []
const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  seenQueries.push(url.search)
  const json = (status: number, body: unknown): void => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (req.headers['authorization'] !== `Bearer ${TOKEN}`)
    return json(403, { error: { code: 'forbidden', message: 'Not authorized' } })
  const m = /^\/v(?:9|10)\/projects\/([^/]+)(\/env)?$/.exec(url.pathname)
  const w = /^\/v(9|10)\/projects\/prj_1\/env(?:\/([^/]+))?$/.exec(url.pathname)
  if (w && (req.method === 'POST' || req.method === 'PATCH')) {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Partial<V>
      writes.push([req.method!, url.pathname + url.search, body])
      if (body.key === 'UNAUTH')
        return json(401, { error: { code: 'unauthorized', message: 'no' } })
      if (body.key === 'REJECT')
        return json(201, {
          created: undefined,
          failed: [{ error: { code: 'invalid', message: 'value too long', key: 'REJECT' } }]
        })
      if (req.method === 'PATCH') {
        const v = envs.find((e) => e.id === w[2])
        if (!v) return json(404, { error: { code: 'not_found', message: 'env not found' } })
        Object.assign(v, body, { updatedAt: 1800000000000 })
        return json(200, v)
      }
      const created: V = {
        id: `n${nextId++}`,
        key: body.key!,
        value: body.value,
        type: body.type ?? 'encrypted',
        target: body.target ?? [],
        ...(body.gitBranch ? { gitBranch: body.gitBranch } : {}),
        updatedAt: 1800000000000
      }
      envs.push(created)
      json(201, { created, failed: [] })
    })
    return
  }
  if (!m) return json(404, { error: { code: 'not_found', message: 'nope' } })
  const proj =
    m[1] === 'prj_1' || m[1] === 'web'
      ? { id: 'prj_1', name: 'web' }
      : m[1] === 'prj_2' || m[1] === 'bare'
        ? { id: 'prj_2', name: 'bare' }
        : null
  if (!proj) return json(404, { error: { code: 'not_found', message: 'Project not found' } })
  if (url.searchParams.get('teamId') === 'team_wrong')
    return json(403, { error: { code: 'forbidden', message: 'not a member of this team' } })
  if (!m[2]) return json(200, proj)
  const decrypt = url.searchParams.get('decrypt') === 'true'
  const until = url.searchParams.get('until')
  if (proj.id === 'prj_2')
    return json(200, {
      envs: [
        {
          id: 'b1',
          key: 'ONLY',
          value: 'x',
          type: 'plain',
          target: ['preview'],
          gitBranch: 'dev',
          updatedAt: 5
        }
      ]
    })
  // Two pages: `until` selects the second.
  const page = until ? envs.slice(3) : envs.slice(0, 3)
  const out = page.map((e) => {
    const { value, ...rest } = e
    return e.type === 'sensitive' || (e.type === 'encrypted' && !decrypt)
      ? rest
      : { ...rest, value }
  })
  json(200, { envs: out, pagination: until ? { next: null } : { next: 1699999999999 } })
})
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
afterAll(() => server.close())

const dir = mkdtempSync(join(tmpdir(), 'drift-vercel-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const store = openStore(join(dir, 'plumbr.db'))
afterAll(() => store.close())
registerVercel(store)

let root = ''
test('connect: resolves the project by name, seals the token, stores no credential in config', async () => {
  const r = await connectVercel(
    store,
    { provider: 'vercel', name: '', token: TOKEN, project: 'web', storage: 'keychain' },
    base
  )
  root = r.root.path
  assert.equal(r.root.kind, 'vercel')
  assert.equal(r.root.label, 'vercel:web')
  assert.match(root, /^vercel:\/\/\d+\/prj_1$/)
  assert.match(r.summary, /4 environment/)
  const conn = store.getConnection((parseRef(root) as { connectionId: number }).connectionId)!
  assert.ok(!JSON.stringify(conn.config).includes(TOKEN))
  assert.equal(conn.config['projectName'], 'web')
  assert.ok(conn.secretBlob?.toString().includes(TOKEN))
  grantRoot(root)
})

test('scan: one file per target plus branch-scoped previews; metadata only (no decrypt)', async () => {
  seenQueries = []
  const scan = await scanRoot(root)
  assert.deepEqual(
    scan.files.map((f) => [f.rel, f.project]),
    [
      ['.env.development', 'web'],
      ['.env.preview', 'web'],
      ['.env.production', 'web'],
      ['branches/feature%2Fx/.env.preview', 'web']
    ]
  )
  assert.ok(seenQueries.every((q) => !q.includes('decrypt=true')))
  assert.equal(scan.files[2].modifiedAt, 1700000100000)
})

test('read: values for readable vars, sensitive vars by name only, invalid names hidden', async () => {
  const prod = await readText(`${root}/.env.production`)
  assert.match(prod, /\nDATABASE_URL=postgres:\/\/prod\n/)
  assert.ok(prod.includes(`STRIPE_KEY="${OPAQUE_VALUE}"`))
  assert.match(prod, /\nVERCEL_URL=\n/)
  assert.ok(!prod.includes('bad key') && !prod.includes('nope'))
  assert.match(prod, /1 key reported by name only/)
  const shape = await envShape(`${root}/.env.production`)
  assert.equal(shape.entries.find((e) => e.key === 'STRIPE_KEY')?.fingerprint, OPAQUE_FINGERPRINT)
  const branch = await readText(`${root}/branches/feature%2Fx/.env.preview`)
  assert.match(branch, /\nFEATURE=branchy\n/)
  assert.ok(!branch.includes('DATABASE_URL'))
  assert.equal((await statRef(`${root}/.env.preview`)).mtimeMs, 1700000100000)
  await assert.rejects(readText(`${root}/.env.nope`), /unknown environment/)
})

test('errors: bad token, wrong team and unknown project are typed and never echo the token', async () => {
  for (const [spec, re] of [
    [{ token: 'wrong', project: 'web' }, /forbidden|unauthorized/i],
    [{ token: TOKEN, project: 'web', teamId: 'team_wrong' }, /team/i],
    [{ token: TOKEN, project: 'ghost' }, /not found/i]
  ] as const) {
    await assert.rejects(
      connectVercel(store, { provider: 'vercel', name: '', storage: 'session', ...spec }, base),
      (e: Error) => {
        assert.match(e.message, re)
        assert.ok(!e.message.includes(TOKEN) && !e.message.includes('wrong'))
        return true
      }
    )
  }
  assert.ok(!JSON.stringify(store.listEvents()).includes(TOKEN))
})

test('scan: every target is a file even when it has no variables (branch-only project)', async () => {
  const r = await connectVercel(
    store,
    { provider: 'vercel', name: '', token: TOKEN, project: 'bare', storage: 'session' },
    base
  )
  assert.match(r.summary, /4 environments/)
  grantRoot(r.root.path)
  const scan = await scanRoot(r.root.path)
  assert.deepEqual(
    scan.files.map((f) => f.rel),
    ['.env.development', '.env.preview', '.env.production', 'branches/dev/.env.preview']
  )
  // An empty target reads as an empty environment, not an error.
  const text = await readText(`${r.root.path}/.env.production`)
  assert.match(text, /^# vercel:bare production/)
  assert.deepEqual((await envShape(`${r.root.path}/.env.production`)).entries, [])
})

test('apply from Vercel into a file: readable vars copy, a sensitive (names-only) var is skipped by metadata', async () => {
  grantRoot(dir)
  const target = join(dir, '.env.local')
  writeFileSync(target, 'DATABASE_URL=old\n')
  const r = await applyPlan(store, {
    left: `${root}/.env.production`,
    right: target,
    keys: ['DATABASE_URL', 'STRIPE_KEY'],
    expectedMtime: statSync(target).mtimeMs
  })
  assert.deepEqual(r.written, ['DATABASE_URL'])
  assert.deepEqual(r.skipped, [{ key: 'STRIPE_KEY', reason: 'value not readable from source' }])
  const after = readFileSync(target, 'utf8')
  assert.match(after, /DATABASE_URL=postgres:\/\/prod/)
  assert.ok(!after.includes(OPAQUE_VALUE) && !after.includes('STRIPE_KEY'))
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
const prod = (): string => `${root}/.env.production`
const branch = (): string => `${root}/branches/feature%2Fx/.env.preview`

test('write: a stale plan is refused before any request; a system variable is refused by name', async () => {
  writes.length = 0
  await assert.rejects(apply(prod(), [{ key: 'DATABASE_URL', value: 'x' }], 1), /changed since/)
  await assert.rejects(
    apply(prod(), [{ key: 'VERCEL_URL', value: 'x' }], 1700000100000),
    /VERCEL_URL.*system/i
  )
  assert.equal(writes.length, 0)
})

test('write: single-target var is PATCHed in place, a new key is POSTed to that target only', async () => {
  writes.length = 0
  const r = await apply(
    prod(),
    [
      { key: 'DATABASE_URL', value: 'postgres://new' },
      { key: 'NEW_KEY', value: 'n' }
    ],
    1700000100000
  )
  assert.deepEqual(r.written, ['DATABASE_URL', 'NEW_KEY'])
  assert.equal(r.verified, true)
  assert.match(r.note ?? '', /redeploy|deployment/i)
  assert.deepEqual(writes, [
    [
      'PATCH',
      '/v9/projects/prj_1/env/e1',
      { value: 'postgres://new', type: 'encrypted', target: ['production'] }
    ],
    [
      'POST',
      '/v10/projects/prj_1/env',
      { key: 'NEW_KEY', value: 'n', type: 'encrypted', target: ['production'] }
    ]
  ])
  assert.match(await readText(prod()), /\nNEW_KEY=n\n/)
  assert.ok(!(await readText(`${root}/.env.preview`)).includes('NEW_KEY'))
})

test('write: a var spanning several targets is split so only the chosen target changes; sensitive stays sensitive and unverifiable', async () => {
  writes.length = 0
  const r = await apply(prod(), [{ key: 'STRIPE_KEY', value: 'sk_new' }])
  assert.deepEqual(r.written, ['STRIPE_KEY'])
  assert.equal(r.verified, false)
  assert.match(r.note ?? '', /STRIPE_KEY.*sensitive/i)
  assert.deepEqual(writes, [
    ['PATCH', '/v9/projects/prj_1/env/e2', { target: ['preview'] }],
    [
      'POST',
      '/v10/projects/prj_1/env',
      { key: 'STRIPE_KEY', value: 'sk_new', type: 'sensitive', target: ['production'] }
    ]
  ])
  const e2 = envs.find((e) => e.id === 'e2')!
  assert.deepEqual(e2.target, ['preview'])
  assert.ok(envs.some((e) => e.key === 'STRIPE_KEY' && e.target.join() === 'production'))
})

test('write: branch-scoped preview files keep gitBranch on update and create', async () => {
  writes.length = 0
  const r = await apply(branch(), [
    { key: 'FEATURE', value: 'b2' },
    { key: 'NEWB', value: 'x' }
  ])
  assert.equal(r.verified, true)
  assert.deepEqual(writes, [
    [
      'PATCH',
      '/v9/projects/prj_1/env/e4',
      { value: 'b2', type: 'encrypted', target: ['preview'], gitBranch: 'feature/x' }
    ],
    [
      'POST',
      '/v10/projects/prj_1/env',
      { key: 'NEWB', value: 'x', type: 'encrypted', target: ['preview'], gitBranch: 'feature/x' }
    ]
  ])
  assert.ok(!(await readText(`${root}/.env.preview`)).includes('NEWB'))
})

test('write: unauthorized and a `failed` entry stop the apply and name the key', async () => {
  await assert.rejects(apply(prod(), [{ key: 'UNAUTH', value: 'x' }]), /UNAUTH.*unauthorized/i)
  await assert.rejects(apply(prod(), [{ key: 'REJECT', value: 'x' }]), /REJECT.*value too long/)
})
