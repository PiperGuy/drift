import { test, vi, afterAll } from 'vitest'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { tempDir } from '../testkit'

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
const { envShape } = await import('../../env')
const { registerSecretsManager, connectSecretsManager, isPrefixSource, _setSmApi } =
  await import('./sm')
type SmApi = import('./sm').SmApi
const { awsError } = await import('./creds')

/** In-memory Secrets Manager: names → string/binary, plus the auth the adapter asked for. */
const secrets = new Map<string, { string?: string; binary?: boolean; changed: number }>([
  [
    'prod/api',
    {
      string: JSON.stringify({
        DATABASE_URL: 'postgres://sm',
        PORT: 5432,
        DEBUG: false,
        nested: { a: 1 },
        'bad key': 'x'
      }),
      changed: 1700000000000
    }
  ],
  ['prod/worker', { string: JSON.stringify({ QUEUE: 'jobs' }), changed: 1700000001000 }],
  ['prod/blob', { binary: true, changed: 1 }],
  ['prod/plain', { string: 'not json at all', changed: 1 }],
  ['prod/list', { string: '[1,2]', changed: 1 }],
  ['staging/api', { string: '{}', changed: 1 }]
])
const asked: { region: string; profile: string | null }[] = []
const fake = (auth: { region: string; profile: string | null }): SmApi => {
  asked.push(auth)
  if (auth.profile === 'expired')
    throw Object.assign(new Error('Token is expired'), { name: 'ExpiredTokenException' })
  return {
    describe: async (name) => {
      const s = secrets.get(name)
      return s ? { name, lastChanged: s.changed } : null
    },
    list: async (prefix, token) => {
      if (auth.profile === 'endless')
        return {
          items: [{ name: `${prefix}x${token ?? 0}`, lastChanged: 1 }],
          nextToken: String(Number(token ?? 0) + 1)
        }
      // Two items per page, like NextToken would give; every page must be followed.
      const all = [...secrets.entries()]
        .filter(([n]) => n.startsWith(prefix))
        .map(([name, s]) => ({ name, lastChanged: s.changed }))
      const from = Number(token ?? 0)
      return {
        items: all.slice(from, from + 2),
        nextToken: from + 2 < all.length ? String(from + 2) : undefined
      }
    },
    get: async (name) => {
      const s = secrets.get(name)
      if (!s)
        throw Object.assign(new Error("Secrets Manager can't find the specified secret."), {
          name: 'ResourceNotFoundException'
        })
      if (name === 'prod/worker' && auth.profile === 'denied')
        throw Object.assign(
          new Error(
            'User: arn:aws:iam::123:user/x is not authorized to perform: secretsmanager:GetSecretValue'
          ),
          { name: 'AccessDeniedException' }
        )
      return s.binary ? { binary: true, string: undefined } : { binary: false, string: s.string }
    }
  }
}
_setSmApi(fake)
const store = openStore(join(tempDir('drift-sm-'), 'plumbr.db'))
afterAll(() => store.close())
registerSecretsManager(store)

let root = ''
test('connect one secret: no credential stored, only region + profile', async () => {
  const r = await connectSecretsManager(store, {
    provider: 'aws-sm',
    name: '',
    region: 'eu-west-1',
    profile: 'dev',
    secret: 'prod/api'
  })
  assert.equal(r.root.kind, 'aws-sm')
  assert.equal(r.root.label, 'aws-sm:prod/api')
  assert.match(r.summary, /1 secret/)
  const conn = store.getConnection(
    (parseRef(r.root.path) as { connectionId: number }).connectionId
  )!
  assert.deepEqual(conn.config, {
    region: 'eu-west-1',
    profile: 'dev',
    mode: 'secret',
    storage: 'session'
  })
  assert.equal(conn.secretBlob, null)
  assert.deepEqual(asked.at(-1), { region: 'eu-west-1', profile: 'dev' })
  grantRoot(r.root.path)
  const scan = await scanRoot(r.root.path)
  assert.deepEqual(
    scan.files.map((f) => [f.rel, f.project, f.modifiedAt]),
    [['api', 'prod', 1700000000000]]
  )
  const text = await readText(scan.files[0].path)
  assert.match(text, /\nDATABASE_URL=postgres:\/\/sm\nPORT=5432\nDEBUG=false\n/)
  assert.ok(!text.includes('nested') && !text.includes('bad key'))
  assert.match(text, /1 key not shown \(object or array value\)/)
  assert.deepEqual(
    (await envShape(scan.files[0].path)).entries.map((e) => e.key),
    ['DATABASE_URL', 'PORT', 'DEBUG']
  )
  assert.equal((await statRef(scan.files[0].path)).mtimeMs, 1700000000000)
})

test('connect a prefix: each JSON object secret under it is one file; the rest fail safely on read', async () => {
  const r = await connectSecretsManager(store, {
    provider: 'aws-sm',
    name: 'Prod',
    region: 'us-east-1',
    secret: 'prod/'
  })
  root = r.root.path
  assert.equal(r.root.label, 'Prod')
  assert.match(r.summary, /5 secrets/)
  grantRoot(root)
  const scan = await scanRoot(root)
  assert.deepEqual(
    scan.files.map((f) => f.rel),
    ['api', 'blob', 'list', 'plain', 'worker']
  )
  assert.equal(scan.files[0].path, `${root}/api`)
  await assert.rejects(readText(`${root}/blob`), /binary secret/)
  await assert.rejects(readText(`${root}/plain`), /not JSON/)
  await assert.rejects(readText(`${root}/list`), /JSON array, not a JSON object/)
  await assert.rejects(readText(`${root}/ghost`), /not found/i)
})

test('errors: missing secret, expired SSO session and access denied are explained', async () => {
  await assert.rejects(
    connectSecretsManager(store, {
      provider: 'aws-sm',
      name: '',
      region: 'us-east-1',
      secret: 'nothing/here'
    }),
    /no secret named .* and none start with/
  )
  await assert.rejects(
    connectSecretsManager(store, {
      provider: 'aws-sm',
      name: '',
      region: 'us-east-1',
      profile: 'expired',
      secret: 'prod/api'
    }),
    /expired.*sso login/i
  )
  const r = await connectSecretsManager(store, {
    provider: 'aws-sm',
    name: '',
    region: 'us-east-1',
    profile: 'denied',
    secret: 'prod/'
  })
  grantRoot(r.root.path)
  await assert.rejects(readText(`${r.root.path}/worker`), /not authorized.*GetSecretValue/)
  assert.ok(!JSON.stringify(store.listEvents()).includes('postgres'))
})

test('awsError: every SDK failure family maps to a useful message', () => {
  const m = (name: string, message = 'msg'): string =>
    awsError(Object.assign(new Error(message), { name }), 'ctx', 'p1').message
  assert.match(
    m('CredentialsProviderError', 'Could not load credentials from any providers'),
    /No AWS credentials.*p1.*aws configure/
  )
  assert.match(m('UnrecognizedClientException'), /rejected the credentials/)
  assert.match(m('ThrottlingException'), /rate limit/i)
  assert.match(m('ClusterNotFoundException'), /not found/)
  assert.match(
    m('AccessDeniedException', 'not authorized to perform: ecs:ListTasks'),
    /ecs:ListTasks/
  )
  assert.match(
    awsError(
      Object.assign(new Error('getaddrinfo ENOTFOUND x'), { code: 'ENOTFOUND' }),
      'ctx',
      null
    ).message,
    /network|reach/i
  )
  assert.match(m('DecryptionFailure'), /KMS/)
})

test('prefix listing: follows every NextToken; an unbounded listing fails loudly instead of a partial scan', async () => {
  const r = await connectSecretsManager(store, {
    provider: 'aws-sm',
    name: '',
    region: 'us-east-1',
    secret: 'prod/'
  })
  grantRoot(r.root.path)
  const scan = await scanRoot(r.root.path)
  assert.deepEqual(
    scan.files.map((f) => f.rel),
    ['api', 'blob', 'list', 'plain', 'worker']
  )
  await assert.rejects(
    connectSecretsManager(store, {
      provider: 'aws-sm',
      name: '',
      region: 'us-east-1',
      profile: 'endless',
      secret: 'prod/'
    }),
    /more than \d+ secrets under prod\/.*narrow/i
  )
})

test('prefix mode is explicit and persisted: `prod/` lists children even when a secret named `prod` exists', async () => {
  secrets.set('prod', { string: '{"WHOLE":"1"}', changed: 1 })
  try {
    const r = await connectSecretsManager(store, {
      provider: 'aws-sm',
      name: '',
      region: 'us-east-1',
      secret: 'prod/'
    })
    const id = (parseRef(r.root.path) as { connectionId: number }).connectionId
    assert.equal(store.getConnection(id)!.config['mode'], 'prefix')
    assert.match(r.summary, /5 secrets/)
    grantRoot(r.root.path)
    // A rescan resolves the mode from the stored connection, never from the ref's spelling.
    const scan = await scanRoot(r.root.path)
    assert.deepEqual(
      scan.files.map((f) => f.rel),
      ['api', 'blob', 'list', 'plain', 'worker']
    )
    assert.ok(scan.files.every((f) => f.path !== r.root.path))
    // Without the slash, `prod` is the one secret.
    const one = await connectSecretsManager(store, {
      provider: 'aws-sm',
      name: '',
      region: 'us-east-1',
      secret: 'prod'
    })
    const oneId = (parseRef(one.root.path) as { connectionId: number }).connectionId
    assert.equal(store.getConnection(oneId)!.config['mode'], 'secret')
    grantRoot(one.root.path)
    assert.deepEqual(
      (await scanRoot(one.root.path)).files.map((f) => f.rel),
      ['prod']
    )
  } finally {
    secrets.delete('prod')
  }
})

test('update source: a prefix source stays a prefix source when reconnected from its root', async () => {
  secrets.set('prod', { string: '{"WHOLE":"1"}', changed: 1 })
  try {
    const first = await connectSecretsManager(store, {
      provider: 'aws-sm',
      name: '',
      region: 'us-east-1',
      secret: 'prod/'
    })
    // What main attaches to the root so the dialog can rebuild the spec faithfully.
    assert.equal(isPrefixSource(store, first.root.path), true)
    // Rebuilding the secret field from the root (Update source) must keep the slash…
    const rebuilt = `${(parseRef(first.root.path) as { path: string }).path}${isPrefixSource(store, first.root.path) ? '/' : ''}`
    assert.equal(rebuilt, 'prod/')
    const again = await connectSecretsManager(store, {
      provider: 'aws-sm',
      name: '',
      region: 'us-east-1',
      secret: rebuilt
    })
    assert.equal(isPrefixSource(store, again.root.path), true)
    grantRoot(again.root.path)
    assert.deepEqual(
      (await scanRoot(again.root.path)).files.map((f) => f.rel),
      ['api', 'blob', 'list', 'plain', 'worker']
    )
    // …and a single-secret source reports no prefix.
    const one = await connectSecretsManager(store, {
      provider: 'aws-sm',
      name: '',
      region: 'us-east-1',
      secret: 'prod/api'
    })
    assert.equal(isPrefixSource(store, one.root.path), false)
    assert.equal(isPrefixSource(store, '/not/a/provider'), false)
  } finally {
    secrets.delete('prod')
  }
})
