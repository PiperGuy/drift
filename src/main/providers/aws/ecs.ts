import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  DescribeServicesCommand,
  DescribeTaskDefinitionCommand,
  DescribeTasksCommand,
  ECSClient,
  ListClustersCommand,
  ListServicesCommand,
  ListTasksCommand
} from '@aws-sdk/client-ecs'
import {
  finish,
  parseScanOutput,
  providerRef,
  registerProviderBackend,
  scanScript,
  type EnvRead,
  type ProviderRef,
  type Stat
} from '../../fs'
import type { Store } from '../../store'
import type {
  EcsDiscoverRequest,
  EcsDiscovery,
  EnvFileInfo,
  ProviderConnectResult,
  ProviderConnectSpec,
  ScanResult
} from '@shared/channels'
import { connectionFor, saveConnection } from '../connection'
import { renderEnv, type Entry } from '../envtext'
import { aws, awsError, credentials, type AwsAuth } from './creds'

/**
 * AWS ECS task containers, read-only. The user picks cluster → service (or one
 * task) → container explicitly, from lists fetched with the SDK. Two read modes:
 *
 *  - task definition (default): the container's `environment` (values) and
 *    `secrets` (names only — they resolve inside the task) from
 *    DescribeTaskDefinition. Pure API; no command ever runs in the container.
 *  - ECS Exec (opt-in, `path` set): `.env*` files under a directory inside the
 *    RUNNING container, read with `aws ecs execute-command` (AWS CLI v2 +
 *    session-manager-plugin, `enableExecuteCommand` on the service/task, and
 *    ecs:ExecuteCommand + ssm permissions). Every scan and read runs `find`,
 *    `stat` or `cat` in the container, so it is offered only when the user asks
 *    for it. Nothing is ever written.
 *
 * Refs: `ecs://<conn>/<cluster>/<service:x|task:id>/<container>/.env` and
 * `ecs://<conn>/<cluster>/<selector>/<container>/fs/<dir>/<file>`.
 */
export type EcsApi = {
  listClusters(): Promise<string[]>
  listServices(cluster: string): Promise<string[]>
  describeServices(
    cluster: string,
    names: string[]
  ): Promise<{ name: string; taskDefinition: string; runningCount: number }[]>
  listTasks(cluster: string, service?: string): Promise<string[]>
  describeTasks(
    cluster: string,
    arns: string[]
  ): Promise<
    {
      arn: string
      id: string
      taskDefinitionArn: string
      lastStatus: string
      group: string
      containers: string[]
    }[]
  >
  describeTaskDefinition(arn: string): Promise<{
    family: string
    revision: number
    registeredAt: number
    containers: {
      name: string
      environment: { name: string; value?: string }[]
      secrets: { name: string; valueFrom: string }[]
      environmentFiles: { value: string; type: string }[]
    }[]
  }>
}

const nameOf = (arn: string): string => arn.split('/').pop() ?? arn
const idOf = (arn: string): string => arn.split('/').pop() ?? arn

/**
 * Follow nextToken until it runs out. A token still pending at the cap is an
 * error naming the listing, never a partial inventory presented as complete.
 */
export async function pageAll<T>(
  next: (token?: string) => Promise<{ items: T[]; token?: string }>,
  what: string,
  maxPages = 20
): Promise<T[]> {
  const out: T[] = []
  let token: string | undefined
  for (let pages = 0; pages === 0 || token; pages++) {
    if (pages >= maxPages)
      throw new Error(
        `${what}: more than ${maxPages} pages; narrow the selection (cluster or service) so the listing can be complete.`
      )
    const r = await next(token)
    out.push(...r.items)
    token = r.token
  }
  return out
}

function realApi(auth: AwsAuth): EcsApi {
  const client = new ECSClient({ region: auth.region, credentials: credentials(auth) })
  const chunks = <T>(xs: T[], n: number): T[][] =>
    Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n))
  return {
    listClusters: async () =>
      (
        await pageAll(async (nextToken) => {
          const r = await client.send(new ListClustersCommand({ nextToken }))
          return { items: r.clusterArns ?? [], token: r.nextToken }
        }, 'ECS clusters')
      ).map(nameOf),
    listServices: async (cluster) =>
      (
        await pageAll(async (nextToken) => {
          const r = await client.send(
            new ListServicesCommand({ cluster, nextToken, maxResults: 100 })
          )
          return { items: r.serviceArns ?? [], token: r.nextToken }
        }, `ECS services in ${cluster}`)
      ).map(nameOf),
    describeServices: async (cluster, names) => {
      const out: { name: string; taskDefinition: string; runningCount: number }[] = []
      for (const part of chunks(names, 10)) {
        const r = await client.send(new DescribeServicesCommand({ cluster, services: part }))
        for (const s of r.services ?? [])
          out.push({
            name: s.serviceName ?? '',
            taskDefinition: s.taskDefinition ?? '',
            runningCount: s.runningCount ?? 0
          })
      }
      return out
    },
    listTasks: async (cluster, service) =>
      pageAll(async (nextToken) => {
        const r = await client.send(
          new ListTasksCommand({
            cluster,
            serviceName: service,
            desiredStatus: 'RUNNING',
            nextToken
          })
        )
        return { items: r.taskArns ?? [], token: r.nextToken }
      }, `ECS tasks in ${cluster}`),
    describeTasks: async (cluster, arns) => {
      const out: Awaited<ReturnType<EcsApi['describeTasks']>> = []
      for (const part of chunks(arns, 100)) {
        const r = await client.send(new DescribeTasksCommand({ cluster, tasks: part }))
        for (const t of r.tasks ?? [])
          out.push({
            arn: t.taskArn ?? '',
            id: idOf(t.taskArn ?? ''),
            taskDefinitionArn: t.taskDefinitionArn ?? '',
            lastStatus: t.lastStatus ?? '',
            group: t.group ?? '',
            containers: (t.containers ?? []).map((c) => c.name ?? '').filter(Boolean)
          })
      }
      return out
    },
    describeTaskDefinition: async (arn) => {
      const r = await client.send(new DescribeTaskDefinitionCommand({ taskDefinition: arn }))
      const td = r.taskDefinition
      return {
        family: td?.family ?? '',
        revision: td?.revision ?? 0,
        registeredAt: td?.registeredAt?.getTime() ?? 0,
        containers: (td?.containerDefinitions ?? []).map((c) => ({
          name: c.name ?? '',
          environment: (c.environment ?? []).map((e) => ({ name: e.name ?? '', value: e.value })),
          secrets: (c.secrets ?? []).map((s) => ({
            name: s.name ?? '',
            valueFrom: s.valueFrom ?? ''
          })),
          environmentFiles: (c.environmentFiles ?? []).map((f) => ({
            value: f.value ?? '',
            type: f.type ?? ''
          }))
        }))
      }
    }
  }
}

let apiFactory: (auth: AwsAuth) => EcsApi = realApi
/** Test seam: swap the SDK for an in-memory fake. */
export function _setEcsApi(f: (auth: AwsAuth) => EcsApi): void {
  apiFactory = f
}
const apiFor = (auth: AwsAuth, context: string): EcsApi => {
  try {
    return apiFactory(auth)
  } catch (e) {
    throw awsError(e, context, auth.profile)
  }
}

// ---------- discovery (for the source dialog) ----------

export async function discoverEcs(req: EcsDiscoverRequest): Promise<EcsDiscovery> {
  const auth: AwsAuth = { region: req.region, profile: req.profile?.trim() || null }
  const ctx = `ECS ${req.cluster ?? 'clusters'} (${auth.region})`
  const api = apiFor(auth, ctx)
  if (!req.cluster)
    return { clusters: await aws(ctx, auth, () => api.listClusters()), services: [], tasks: [] }
  const cluster = req.cluster
  const names = await aws(ctx, auth, () => api.listServices(cluster))
  const services = names.length
    ? await aws(ctx, auth, () => api.describeServices(cluster, names))
    : []
  const tdCache = new Map<string, Promise<Awaited<ReturnType<EcsApi['describeTaskDefinition']>>>>()
  const td = (arn: string): Promise<Awaited<ReturnType<EcsApi['describeTaskDefinition']>>> => {
    let p = tdCache.get(arn)
    if (!p) {
      p = aws(ctx, auth, () => api.describeTaskDefinition(arn))
      tdCache.set(arn, p)
    }
    return p
  }
  const taskArns = await aws(ctx, auth, () => api.listTasks(cluster))
  const tasks = taskArns.length
    ? await aws(ctx, auth, () => api.describeTasks(cluster, taskArns))
    : []
  return {
    clusters: [cluster],
    services: await Promise.all(
      services.map(async (s) => ({
        name: s.name,
        taskDefinition: nameOf(s.taskDefinition),
        running: s.runningCount,
        containers: (await td(s.taskDefinition)).containers.map((c) => c.name)
      }))
    ),
    tasks: await Promise.all(
      tasks.map(async (t) => ({
        id: t.id,
        family: (await td(t.taskDefinitionArn)).family,
        lastStatus: t.lastStatus,
        containers: t.containers
      }))
    )
  }
}

// ---------- refs ----------

type Target = {
  cluster: string
  selector: string
  container: string
  dir: string | null
  file: string | null
}

/** `<cluster>/<selector>/<container>[/.env | /fs/<dir>[/<file>]]` */
function parseTarget(path: string): Target {
  const m = /^([^/]+)\/((?:service|task):[^/]+)\/([^/]+)(?:\/(.*))?$/.exec(path)
  if (!m) throw new Error(`${path}: not an ECS container ref`)
  const rest = m[4] ?? ''
  const t: Target = { cluster: m[1], selector: m[2], container: m[3], dir: null, file: null }
  if (rest === '' || rest === '.env') return t
  // `fs` alone is the container's root directory (refs cannot carry a trailing slash).
  const fs = /^fs(\/.*)?$/.exec(rest)
  if (!fs) throw new Error(`${path}: not an ECS container ref`)
  t.dir = fs[1] ?? '/'
  return t
}

// ---------- task definition mode ----------

async function taskDefinitionFor(
  api: EcsApi,
  auth: AwsAuth,
  t: Target
): Promise<{ arn: string; running: string[] }> {
  const ctx = `ECS ${t.cluster}/${t.selector.replace(':', ' ')}`
  const [kind, name] = t.selector.split(':', 2) as ['service' | 'task', string]
  if (kind === 'service') {
    const s = (await aws(ctx, auth, () => api.describeServices(t.cluster, [name])))[0]
    if (!s) throw new Error(`${ctx}: service ${name} not found in cluster ${t.cluster}.`)
    return {
      arn: s.taskDefinition,
      running: await aws(ctx, auth, () => api.listTasks(t.cluster, name))
    }
  }
  const task = (await aws(ctx, auth, () => api.describeTasks(t.cluster, [name])))[0]
  if (!task)
    throw new Error(
      `${ctx}: task ${name} not found in cluster ${t.cluster} (tasks are replaced on every deployment; a service selector survives that).`
    )
  return { arn: task.taskDefinitionArn, running: task.lastStatus === 'RUNNING' ? [task.arn] : [] }
}

async function containerEnv(
  api: EcsApi,
  auth: AwsAuth,
  t: Target
): Promise<{
  entries: Entry[]
  files: string[]
  registeredAt: number
  label: string
  running: string[]
}> {
  const { arn, running } = await taskDefinitionFor(api, auth, t)
  const td = await aws(`ECS task definition ${nameOf(arn)}`, auth, () =>
    api.describeTaskDefinition(arn)
  )
  const c = td.containers.find((x) => x.name === t.container)
  if (!c)
    throw new Error(
      `ECS ${t.cluster}/${t.selector.replace(':', ' ')}: container ${t.container} not in task definition ${nameOf(arn)} (containers: ${td.containers.map((x) => x.name).join(', ') || 'none'}).`
    )
  const entries: Entry[] = [
    ...c.environment.map((e) => ({ key: e.name, value: e.value ?? '' })),
    ...c.secrets.map((s) => ({ key: s.name, value: null }))
  ]
  return {
    entries,
    files: c.environmentFiles.map((f) => f.value),
    registeredAt: td.registeredAt,
    label: nameOf(arn),
    running
  }
}

// ---------- ECS Exec mode ----------

const run = promisify(execFile)
const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

/** `aws ecs execute-command …` as an argument array. The script goes through --command untouched. */
export function ecsExecArgs(
  auth: AwsAuth,
  cluster: string,
  taskArn: string,
  container: string,
  command: string
): string[] {
  return [
    'ecs',
    'execute-command',
    '--region',
    auth.region,
    ...(auth.profile ? ['--profile', auth.profile] : []),
    '--cluster',
    cluster,
    '--task',
    taskArn,
    '--container',
    container,
    '--interactive',
    '--command',
    command
  ]
}

/**
 * The session runs on a pty, so output is wrapped in markers and base64 to
 * survive CR/LF translation, echo and the session banners; the exit code rides
 * along at the end of the payload.
 */
export function parseExecOutput(raw: string): string {
  const m = /__DRIFT_BEGIN__([\s\S]*?)__DRIFT_END__/.exec(raw)
  if (!m) throw new Error('ECS Exec returned no output (the session may have failed to start).')
  const text = Buffer.from(m[1].replace(/[^A-Za-z0-9+/=]/g, ''), 'base64').toString('utf8')
  const rc = /__DRIFT_RC__(\d+)\n?$/.exec(text)
  if (!rc) throw new Error('ECS Exec output was truncated.')
  const body = text.slice(0, rc.index)
  if (rc[1] !== '0')
    throw new Error(
      `ECS Exec: the command failed in the container (exit code ${rc[1]}).${body ? ` ${body.trim().split('\n').pop()}` : ''}`
    )
  return body
}

async function ecsExec(
  auth: AwsAuth,
  t: Target,
  taskArn: string,
  script: string,
  timeoutMs = 90_000
): Promise<string> {
  const wrapped = `echo __DRIFT_BEGIN__; { ${script}; echo "__DRIFT_RC__$?"; } 2>&1 | base64 | tr -d '\\n'; echo; echo __DRIFT_END__`
  try {
    const { stdout } = await run(
      'aws',
      ecsExecArgs(auth, t.cluster, taskArn, t.container, `sh -c ${q(wrapped)}`),
      {
        timeout: timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, AWS_PAGER: '' }
      }
    )
    return parseExecOutput(stdout)
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: string }
    if (err.code === 'ENOENT')
      throw new Error(
        'ECS Exec needs the AWS CLI v2 (`aws`) and the Session Manager plugin installed on this machine.'
      )
    if (/__DRIFT_/.test(err.message)) throw e
    const msg = (err.stderr ?? '').trim().split('\n').filter(Boolean).pop() ?? err.message
    let hint = ''
    if (/SessionManagerPlugin is not found/i.test(msg))
      hint = 'Install the Session Manager plugin for the AWS CLI.'
    else if (/execute command was not enabled|not enabled/i.test(msg))
      hint = 'Enable ECS Exec on the service (enableExecuteCommand) and redeploy.'
    else if (/TargetNotConnected/i.test(msg))
      hint =
        'The task is not connected to SSM: check the task role (ssmmessages:*) and that the agent started.'
    else if (/AccessDenied|not authorized/i.test(msg))
      hint = 'Your IAM identity needs ecs:ExecuteCommand on this task.'
    throw new Error(`ECS Exec ${t.cluster}/${t.container}: ${msg}${hint ? ` ${hint}` : ''}`)
  }
}

async function runningTask(api: EcsApi, auth: AwsAuth, t: Target): Promise<string> {
  const { running } = await taskDefinitionFor(api, auth, t)
  const arn = [...running].sort()[0]
  if (!arn)
    throw new Error(
      `ECS ${t.cluster}/${t.selector.replace(':', ' ')}: no running task, so there is nothing to read with ECS Exec.`
    )
  return arn
}

// ---------- backend ----------

let storeRef: Store | null = null
const requireStore = (): Store => {
  if (!storeRef) throw new Error('ECS sources are only available inside the Drift app.')
  return storeRef
}
const authFor = (store: Store, id: number): AwsAuth => {
  const c = connectionFor(store, id, 'ecs').config as { region: string; profile: string | null }
  return { region: c.region, profile: c.profile ?? null }
}

async function backendReadEnv(r: ProviderRef): Promise<EnvRead> {
  const auth = authFor(requireStore(), r.connectionId)
  const t = parseTarget(r.path)
  const api = apiFor(auth, `ECS ${t.cluster}`)
  if (t.dir)
    return {
      text: await ecsExec(auth, t, await runningTask(api, auth, t), `cat ${q(t.dir)}`),
      opaque: new Set()
    }
  const env = await containerEnv(api, auth, t)
  return renderEnv(
    [
      `ecs:${t.cluster}/${t.selector.replace(':', ' ')}/${t.container} · task definition ${env.label} (${auth.region}) · values live in the task definition`,
      ...(env.files.length
        ? [`${env.files.length} environmentFiles not read (S3): ${env.files.join(', ')}`]
        : [])
    ],
    env.entries
  )
}

async function backendStat(r: ProviderRef): Promise<Stat> {
  const auth = authFor(requireStore(), r.connectionId)
  const t = parseTarget(r.path)
  const api = apiFor(auth, `ECS ${t.cluster}`)
  if (!t.dir) return { mtimeMs: (await containerEnv(api, auth, t)).registeredAt, size: 0 }
  const out = (
    await ecsExec(auth, t, await runningTask(api, auth, t), `stat -c '%Y %s %y' ${q(t.dir)}`)
  ).trim()
  const m = /^(\d+) (\d+) \S+ \d\d:\d\d:\d\d(?:\.(\d+))?/.exec(out)
  if (!m) throw new Error(`${r.path}: not found`)
  return {
    mtimeMs: Number(m[1]) * 1000 + (m[3] ? Number(`0.${m[3]}`) * 1000 : 0),
    size: Number(m[2])
  }
}

async function backendScan(root: string, r: ProviderRef): Promise<ScanResult> {
  const started = performance.now()
  const auth = authFor(requireStore(), r.connectionId)
  const t = parseTarget(r.path)
  const api = apiFor(auth, `ECS ${t.cluster}`)
  const project = `${t.cluster}/${t.selector.split(':')[1]}/${t.container}`
  if (t.dir) {
    const out = await ecsExec(auth, t, await runningTask(api, auth, t), scanScript(t.dir), 120_000)
    const base = `${t.cluster}/${t.selector}/${t.container}/fs`
    const { files, dirs } = parseScanOutput(
      root,
      out,
      (p) => providerRef('ecs', r.connectionId, `${base}${p}`),
      t.dir
    )
    for (const f of files) f.project = f.project ? `${project}:${f.project}` : project
    return finish(root, files, dirs, started)
  }
  const env = await containerEnv(api, auth, t)
  const file: EnvFileInfo = {
    path: providerRef('ecs', r.connectionId, `${t.cluster}/${t.selector}/${t.container}/.env`),
    root,
    rel: '.env',
    name: '.env',
    project,
    modifiedAt: env.registeredAt,
    size: 0
  }
  return finish(root, [file], 1, started)
}

export function registerEcs(store: Store): void {
  storeRef = store
  registerProviderBackend('ecs', {
    readEnv: backendReadEnv,
    readText: (r) => backendReadEnv(r).then((e) => e.text),
    stat: backendStat,
    scan: backendScan
  })
}

export async function connectEcs(
  store: Store,
  spec: Extract<ProviderConnectSpec, { provider: 'ecs' }>
): Promise<ProviderConnectResult> {
  const auth: AwsAuth = { region: spec.region, profile: spec.profile?.trim() || null }
  const api = apiFor(auth, `ECS ${spec.cluster}`)
  // `/` stays `/` (an explicit directory); anything else loses trailing slashes; empty = task definition mode.
  const trimmed = spec.path?.trim() ?? ''
  const dir = trimmed === '' ? null : trimmed.replace(/\/+$/, '') || '/'
  const t: Target = {
    cluster: spec.cluster,
    selector: spec.selector,
    container: spec.container,
    dir,
    file: null
  }
  const env = await containerEnv(api, auth, t)
  const warnings: string[] = []
  if (env.files.length)
    warnings.push(
      `The task definition also loads ${env.files.length} environment file${env.files.length === 1 ? '' : 's'} from S3 (environmentFiles); those keys are not read.`
    )
  const secrets = env.entries.filter((e) => e.value === null).length
  if (secrets)
    warnings.push(
      `${secrets} key${secrets === 1 ? '' : 's'} come from Secrets Manager / SSM at task start; the API returns their names only (compared as "unknown"). Add the secret itself as an AWS Secrets Manager source to compare values.`
    )
  if (dir) {
    if (env.running.length === 0)
      throw new Error(
        `ECS ${t.cluster}/${t.selector.replace(':', ' ')}: no running task, so there is nothing to read with ECS Exec.`
      )
    warnings.push(
      `ECS Exec mode: every scan and read runs find/stat/cat inside the running container over \`aws ecs execute-command\`. Needs AWS CLI v2, the Session Manager plugin, enableExecuteCommand and ecs:ExecuteCommand.`
    )
    // Verify the directory now, so a typo fails here and not on the first scan.
    const out = (
      await ecsExec(
        auth,
        t,
        [...env.running].sort()[0],
        `test -d ${q(dir)} && echo ok || echo missing`
      )
    ).trim()
    if (out !== 'ok')
      throw new Error(`ECS ${t.container}: ${dir} is not a directory in the container.`)
  }
  const selectorName = spec.selector.split(':')[1]
  const label = spec.name.trim() || `ecs:${spec.cluster}/${selectorName}/${spec.container}`
  const saved = saveConnection(
    store,
    'ecs',
    label,
    { region: auth.region, profile: auth.profile },
    null,
    'session'
  )
  const path = `${spec.cluster}/${spec.selector}/${spec.container}${dir ? `/fs${dir}` : ''}`
  return {
    root: { path: providerRef('ecs', saved.id, path), kind: 'ecs', label },
    summary: dir
      ? `files under ${dir} in ${spec.container} via ECS Exec · task definition ${env.label} · read-only`
      : `task definition ${env.label} · ${env.entries.length - secrets} value${env.entries.length - secrets === 1 ? '' : 's'} · ${secrets} secret${secrets === 1 ? '' : 's'} (names only) · read-only`,
    warnings
  }
}
