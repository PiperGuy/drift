import { test, vi, afterAll } from 'vitest'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
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
const { readText, scanRoot, statRef, writeAtomic } = await import('../../fs')
const { envShape } = await import('../../env')
const { registerEcs, connectEcs, discoverEcs, _setEcsApi, ecsExecArgs, parseExecOutput, pageAll } =
  await import('./ecs')
type EcsApi = import('./ecs').EcsApi
const { awsProfiles } = await import('./creds')
const { OPAQUE_FINGERPRINT } = await import('@shared/drift')

const dir = tempDir('drift-ecs-')
const TD = 'arn:aws:ecs:eu-west-1:123456789012:task-definition/api:7'
const TASK = 'arn:aws:ecs:eu-west-1:123456789012:task/prod/0123456789abcdef0123456789abcdef'
const fake: EcsApi = {
  listClusters: async () => ['prod', 'staging'],
  listServices: async (cluster) => (cluster === 'prod' ? ['api', 'worker'] : []),
  describeServices: async (cluster, names) =>
    names
      .filter((n) => cluster === 'prod' && ['api', 'worker'].includes(n))
      .map((name) => ({ name, taskDefinition: TD, runningCount: name === 'api' ? 2 : 0 })),
  listTasks: async (cluster, service) =>
    cluster === 'prod' && (!service || service === 'api') ? [TASK] : [],
  describeTasks: async (_cluster, arns) =>
    arns.includes(TASK)
      ? [
          {
            arn: TASK,
            id: '0123456789abcdef0123456789abcdef',
            taskDefinitionArn: TD,
            lastStatus: 'RUNNING',
            group: 'service:api',
            containers: ['api', 'sidecar']
          }
        ]
      : [],
  describeTaskDefinition: async (arn) => {
    if (arn !== TD)
      throw Object.assign(new Error('Unable to describe task definition.'), {
        name: 'ClientException'
      })
    return {
      family: 'api',
      revision: 7,
      registeredAt: 1700000000000,
      containers: [
        {
          name: 'api',
          environment: [
            { name: 'DATABASE_URL', value: 'postgres://ecs' },
            { name: 'PORT', value: '3000' }
          ],
          secrets: [
            {
              name: 'STRIPE_KEY',
              valueFrom:
                'arn:aws:secretsmanager:eu-west-1:123456789012:secret:prod/stripe-AbCdEf:key::'
            }
          ],
          environmentFiles: [{ value: 'arn:aws:s3:::bucket/prod.env', type: 's3' }]
        },
        { name: 'sidecar', environment: [], secrets: [], environmentFiles: [] }
      ]
    }
  }
}
_setEcsApi(() => fake)
const store = openStore(join(dir, 'plumbr.db'))
afterAll(() => store.close())
registerEcs(store)

test("discover: clusters, then one cluster's services and running tasks with their containers", async () => {
  const top = await discoverEcs({ region: 'eu-west-1' })
  assert.deepEqual(top, { clusters: ['prod', 'staging'], services: [], tasks: [] })
  const prod = await discoverEcs({ region: 'eu-west-1', cluster: 'prod' })
  assert.deepEqual(prod.services, [
    { name: 'api', taskDefinition: 'api:7', running: 2, containers: ['api', 'sidecar'] },
    { name: 'worker', taskDefinition: 'api:7', running: 0, containers: ['api', 'sidecar'] }
  ])
  assert.deepEqual(prod.tasks, [
    {
      id: '0123456789abcdef0123456789abcdef',
      family: 'api',
      lastStatus: 'RUNNING',
      containers: ['api', 'sidecar']
    }
  ])
})

let root = ''
test('task definition mode: one .env from the API, secrets by name only, no command runs', async () => {
  const r = await connectEcs(store, {
    provider: 'ecs',
    name: '',
    region: 'eu-west-1',
    profile: 'dev',
    cluster: 'prod',
    selector: 'service:api',
    container: 'api'
  })
  root = r.root.path
  assert.equal(r.root.label, 'ecs:prod/api/api')
  assert.match(r.summary, /task definition api:7/)
  assert.ok(r.warnings.some((w) => /environmentFiles|env file/i.test(w)))
  grantRoot(root)
  const scan = await scanRoot(root)
  assert.deepEqual(
    scan.files.map((f) => [f.rel, f.project, f.modifiedAt]),
    [['.env', 'prod/api/api', 1700000000000]]
  )
  const text = await readText(scan.files[0].path)
  assert.match(text, /\nDATABASE_URL=postgres:\/\/ecs\nPORT=3000\n/)
  assert.match(text, /1 key reported by name only/)
  assert.ok(!text.includes('AbCdEf'))
  const shape = await envShape(scan.files[0].path)
  assert.equal(shape.entries.find((e) => e.key === 'STRIPE_KEY')?.fingerprint, OPAQUE_FINGERPRINT)
  assert.equal((await statRef(scan.files[0].path)).mtimeMs, 1700000000000)
  await assert.rejects(writeAtomic(scan.files[0].path, 'X=1\n'), /read-only/)
})

test('connect validation: unknown cluster, service, container and a task without the container', async () => {
  const base = { provider: 'ecs' as const, name: '', region: 'eu-west-1' }
  await assert.rejects(
    connectEcs(store, { ...base, cluster: 'nope', selector: 'service:api', container: 'api' }),
    /service api.*not found in cluster nope/i
  )
  await assert.rejects(
    connectEcs(store, { ...base, cluster: 'prod', selector: 'service:ghost', container: 'api' }),
    /service ghost/i
  )
  await assert.rejects(
    connectEcs(store, { ...base, cluster: 'prod', selector: 'service:api', container: 'db' }),
    /container db.*api, sidecar/i
  )
  await assert.rejects(
    connectEcs(store, { ...base, cluster: 'prod', selector: 'task:ffffffff', container: 'api' }),
    /task ffffffff/i
  )
})

test('ecsExecArgs: argument array with region/profile, never a shell string', () => {
  assert.deepEqual(
    ecsExecArgs({ region: 'eu-west-1', profile: 'dev' }, 'prod', TASK, 'api', 'echo hi'),
    [
      'ecs',
      'execute-command',
      '--region',
      'eu-west-1',
      '--profile',
      'dev',
      '--cluster',
      'prod',
      '--task',
      TASK,
      '--container',
      'api',
      '--interactive',
      '--command',
      'echo hi'
    ]
  )
  assert.ok(
    !ecsExecArgs({ region: 'eu-west-1', profile: null }, 'prod', TASK, 'api', 'x').includes(
      '--profile'
    )
  )
})

test('parseExecOutput: strips the session banners and CRs, decodes the payload, surfaces the exit code', () => {
  const payload = Buffer.from('hello\nworld\n__DRIFT_RC__0').toString('base64')
  const out = `\r\nStarting session with SessionId: ecs-execute-command-abc\r\n__DRIFT_BEGIN__\r\n${payload.slice(0, 10)}\r\n${payload.slice(10)}\r\n__DRIFT_END__\r\n\r\nExiting session with sessionId: ecs-execute-command-abc.\r\n`
  assert.equal(parseExecOutput(out), 'hello\nworld\n')
  const failed = Buffer.from('__DRIFT_RC__2').toString('base64')
  assert.throws(() => parseExecOutput(`__DRIFT_BEGIN__\n${failed}\n__DRIFT_END__\n`), /exit code 2/)
  assert.throws(() => parseExecOutput('Starting session\n\nExiting session'), /no output/i)
})

test('ECS Exec mode: files inside the running container via a fake aws CLI', async () => {
  // Fake `aws`: prints the session banners around `sh -c <command>` run locally.
  const bin = join(dir, 'bin')
  mkdirSync(bin, { recursive: true })
  const log = join(dir, 'aws.log')
  writeFileSync(
    join(bin, 'aws'),
    `#!/bin/sh
printf '%s\\n' "$@" >> ${JSON.stringify(log)}
cmd=""
while [ $# -gt 0 ]; do if [ "$1" = "--command" ]; then cmd="$2"; fi; shift; done
printf '\\r\\nStarting session with SessionId: ecs-execute-command-0\\r\\n'
sh -c "$cmd" | sed 's/$/\\r/'
printf '\\r\\n\\r\\nExiting session with sessionId: ecs-execute-command-0.\\r\\n'
`
  )
  chmodSync(join(bin, 'aws'), 0o755)
  const app = join(dir, 'app')
  mkdirSync(join(app, 'svc'), { recursive: true })
  writeFileSync(join(app, 'svc', '.env.production'), 'A=1\nB="two words"\n')
  const oldPath = process.env['PATH']
  process.env['PATH'] = `${bin}:${oldPath}`
  try {
    const r = await connectEcs(store, {
      provider: 'ecs',
      name: '',
      region: 'eu-west-1',
      cluster: 'prod',
      selector: 'service:api',
      container: 'api',
      path: app
    })
    assert.ok(r.warnings.some((w) => /ECS Exec/.test(w)))
    grantRoot(r.root.path)
    const scan = await scanRoot(r.root.path)
    assert.deepEqual(
      scan.files.map((f) => f.rel),
      ['svc/.env.production']
    )
    assert.equal(await readText(scan.files[0].path), 'A=1\nB="two words"\n')
    assert.equal((await statRef(scan.files[0].path)).size, 18)
    await assert.rejects(writeAtomic(scan.files[0].path, 'X=1\n'), /read-only/)
    const calls = (await import('node:fs')).readFileSync(log, 'utf8')
    assert.ok(calls.includes(`--task\n${TASK}\n--container\napi\n--interactive\n--command\n`))
    assert.ok(!calls.includes('--profile'))
    // A service with no running task cannot be read.
    await assert.rejects(
      connectEcs(store, {
        provider: 'ecs',
        name: '',
        region: 'eu-west-1',
        cluster: 'prod',
        selector: 'service:worker',
        container: 'api',
        path: app
      }),
      /no running task/i
    )
  } finally {
    process.env['PATH'] = oldPath
  }
})

test('ECS Exec mode: a forged renderer ref cannot cat outside the granted directory', async () => {
  const bin = join(dir, 'bin')
  const app = join(dir, 'app')
  const log = join(dir, 'aws.log')
  mkdirSync(join(dir, 'outside'), { recursive: true })
  writeFileSync(join(dir, 'outside', '.env'), 'LEAK=1\n')
  const oldPath = process.env['PATH']
  process.env['PATH'] = `${bin}:${oldPath}`
  try {
    const r = await connectEcs(store, {
      provider: 'ecs',
      name: '',
      region: 'eu-west-1',
      cluster: 'prod',
      selector: 'service:api',
      container: 'api',
      path: app
    })
    grantRoot(r.root.path)
    const before = (await import('node:fs')).readFileSync(log, 'utf8')
    for (const forged of [
      `${r.root.path}/../outside/.env`,
      `${r.root.path}/svc/../../outside/.env`
    ])
      await assert.rejects(envShape(forged), /outside every granted workspace root/)
    assert.equal((await import('node:fs')).readFileSync(log, 'utf8'), before)
    assert.ok((await envShape(`${r.root.path}/svc/.env.production`)).entries.length > 0)
  } finally {
    process.env['PATH'] = oldPath
  }
})

test('ECS Exec mode: `/` is an explicit directory, never task-definition mode', async () => {
  const bin = join(dir, 'bin')
  const app = join(dir, 'app')
  const oldPath = process.env['PATH']
  process.env['PATH'] = `${bin}:${oldPath}`
  try {
    const r = await connectEcs(store, {
      provider: 'ecs',
      name: '',
      region: 'eu-west-1',
      cluster: 'prod',
      selector: 'service:api',
      container: 'api',
      path: '/'
    })
    assert.match(r.root.path, /\/fs$/)
    assert.match(r.summary, /files under \/ in api via ECS Exec/)
    assert.ok(r.warnings.some((w) => /ECS Exec/.test(w)))
    grantRoot(r.root.path)
    const file = `${r.root.path}${join(app, 'svc', '.env.production')}`
    assert.equal(await readText(file), 'A=1\nB="two words"\n')
    assert.equal((await statRef(file)).size, 18)
  } finally {
    process.env['PATH'] = oldPath
  }
})

test('awsProfiles: names from config and credentials files, deduplicated', async () => {
  const aws = join(dir, 'aws')
  mkdirSync(aws, { recursive: true })
  writeFileSync(
    join(aws, 'config'),
    '[default]\nregion=eu-west-1\n[profile dev]\nsso_session = x\n[profile prod ]\n[sso-session x]\n'
  )
  writeFileSync(join(aws, 'credentials'), '[dev]\naws_access_key_id = AKIA_NOT_REAL\n[legacy]\n')
  assert.deepEqual(await awsProfiles(aws), ['default', 'dev', 'legacy', 'prod'])
  assert.deepEqual(await awsProfiles(join(dir, 'missing')), [])
})

test('pageAll: follows every nextToken; a token left at the cap is a clear error, not a partial inventory', async () => {
  const three = await pageAll<string>(async (token) => {
    const n = Number(token ?? 0)
    return { items: [`t${n}`], token: n < 2 ? String(n + 1) : undefined }
  }, 'ECS tasks')
  assert.deepEqual(three, ['t0', 't1', 't2'])
  await assert.rejects(
    pageAll<string>(
      async (token) => ({ items: ['secret-arn'], token: String(Number(token ?? 0) + 1) }),
      'ECS services',
      20
    ),
    (e: Error) =>
      /ECS services.*more than 20 pages/.test(e.message) && !e.message.includes('secret-arn')
  )
})
