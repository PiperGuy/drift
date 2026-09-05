import { posix } from 'node:path'
import {
  DescribeSecretCommand,
  GetSecretValueCommand,
  ListSecretsCommand,
  PutSecretValueCommand,
  SecretsManagerClient
} from '@aws-sdk/client-secrets-manager'
import {
  finish,
  parseRef,
  providerRef,
  registerProviderBackend,
  type EnvRead,
  type ProviderRef,
  type ProviderWrite,
  type ProviderWriteResult,
  type Stat
} from '../../fs'
import type { Store } from '../../store'
import type {
  EnvFileInfo,
  ProviderConnectResult,
  ProviderConnectSpec,
  ScanResult
} from '@shared/channels'
import { connectionFor, saveConnection } from '../connection'
import { renderEnv, type Entry } from '../envtext'
import { unconfirmed } from '../writekit'
import { aws, awsError, credentials, type AwsAuth } from './creds'

/**
 * AWS Secrets Manager. A source is one secret (one environment) or a name
 * prefix ending in `/` (each JSON-object secret below it is one environment).
 * Only `SecretString` bodies that parse as a JSON object are readable: binary
 * secrets, plaintext and JSON arrays/scalars fail with a safe message and are
 * never rendered. Values are fetched only when a file is read.
 *
 * Writes (PutSecretValue) create a new version holding the current JSON object
 * with only the approved keys replaced: every other key keeps its value and its
 * JSON type. The version read immediately before the put is the base; after
 * the put, DescribeSecret's staging labels must show that base as AWSPREVIOUS,
 * otherwise another writer landed in between and the result says so. The
 * ClientRequestToken is unique per apply, so a retried request can never mint
 * a second version. Credentials: the SDK chain only, never a stored key.
 */
export type SmApi = {
  describe(name: string): Promise<{ name: string; lastChanged: number } | null>
  /** One page of names under a prefix; the adapter follows nextToken until it runs out. */
  list(
    prefix: string,
    nextToken?: string
  ): Promise<{ items: { name: string; lastChanged: number }[]; nextToken?: string }>
  get(
    name: string,
    versionId?: string
  ): Promise<{ binary: boolean; string: string | undefined; versionId?: string }>
  put(
    name: string,
    secretString: string,
    clientRequestToken: string
  ): Promise<{ versionId: string }>
  /** DescribeSecret's VersionIdsToStages. */
  stages(name: string): Promise<Record<string, string[]>>
}

/** 100 pages × 100 secrets. Beyond that the listing is refused, never truncated. */
const MAX_PAGES = 100

function realApi(auth: AwsAuth): SmApi {
  const client = new SecretsManagerClient({ region: auth.region, credentials: credentials(auth) })
  return {
    describe: async (name) => {
      try {
        const r = await client.send(new DescribeSecretCommand({ SecretId: name }))
        return { name: r.Name ?? name, lastChanged: r.LastChangedDate?.getTime() ?? 0 }
      } catch (e) {
        if ((e as { name?: string }).name === 'ResourceNotFoundException') return null
        throw e
      }
    },
    list: async (prefix, nextToken) => {
      const r = await client.send(
        new ListSecretsCommand({
          Filters: [{ Key: 'name', Values: [prefix] }],
          MaxResults: 100,
          NextToken: nextToken
        })
      )
      return {
        items: (r.SecretList ?? []).flatMap((s) =>
          s.Name?.startsWith(prefix)
            ? [{ name: s.Name, lastChanged: s.LastChangedDate?.getTime() ?? 0 }]
            : []
        ),
        nextToken: r.NextToken
      }
    },
    get: async (name, versionId) => {
      const r = await client.send(
        new GetSecretValueCommand({ SecretId: name, VersionId: versionId })
      )
      return {
        binary: r.SecretBinary !== undefined && r.SecretString === undefined,
        string: r.SecretString,
        versionId: r.VersionId
      }
    },
    put: async (name, secretString, clientRequestToken) => {
      const r = await client.send(
        new PutSecretValueCommand({
          SecretId: name,
          SecretString: secretString,
          ClientRequestToken: clientRequestToken
        })
      )
      return { versionId: r.VersionId ?? clientRequestToken }
    },
    stages: async (name) => {
      const r = await client.send(new DescribeSecretCommand({ SecretId: name }))
      return r.VersionIdsToStages ?? {}
    }
  }
}

let apiFactory: (auth: AwsAuth) => SmApi = realApi
/** Test seam: swap the SDK for an in-memory fake. */
export function _setSmApi(f: (auth: AwsAuth) => SmApi): void {
  apiFactory = f
}

let storeRef: Store | null = null
const requireStore = (): Store => {
  if (!storeRef)
    throw new Error('AWS Secrets Manager sources are only available inside the Drift app.')
  return storeRef
}
const authFor = (store: Store, id: number): AwsAuth => {
  const c = connectionFor(store, id, 'aws-sm').config as { region: string; profile: string | null }
  return { region: c.region, profile: c.profile ?? null }
}
const apiFor = (auth: AwsAuth, context: string): SmApi => {
  try {
    return apiFactory(auth)
  } catch (e) {
    throw awsError(e, context, auth.profile)
  }
}

/** Parse a secret body into env entries, or explain why it cannot be one. */
export function secretEntries(
  name: string,
  body: { binary: boolean; string: string | undefined }
): { entries: Entry[]; nested: number } {
  if (body.binary || body.string === undefined)
    throw new Error(`${name} is a binary secret. Drift reads JSON object secrets only.`)
  let json: unknown
  try {
    json = JSON.parse(body.string)
  } catch {
    throw new Error(`${name} is not JSON. Drift reads JSON object secrets only (key/value pairs).`)
  }
  if (json === null || typeof json !== 'object' || Array.isArray(json))
    throw new Error(
      `${name} is a JSON ${Array.isArray(json) ? 'array' : json === null ? 'null' : typeof json}, not a JSON object of key/value pairs.`
    )
  const entries: Entry[] = []
  let nested = 0
  for (const [key, v] of Object.entries(json as Record<string, unknown>)) {
    if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
      entries.push({ key, value: v === null ? '' : String(v) })
    else nested += 1
  }
  return { entries, nested }
}

async function backendReadEnv(r: ProviderRef): Promise<EnvRead> {
  const auth = authFor(requireStore(), r.connectionId)
  const name = r.path
  const ctx = `Secrets Manager ${name}`
  const body = await aws(ctx, auth, () => apiFor(auth, ctx).get(name))
  const { entries, nested } = secretEntries(name, body)
  return renderEnv(
    [
      `aws-sm:${name} (${auth.region}) · values live in AWS Secrets Manager`,
      ...(nested
        ? [`${nested} key${nested === 1 ? '' : 's'} not shown (object or array value)`]
        : [])
    ],
    entries
  )
}

/** The full JSON object (not just the env-shaped keys), or a safe error. */
function secretObject(
  name: string,
  body: { binary: boolean; string: string | undefined }
): Record<string, unknown> {
  secretEntries(name, body) // same validation and messages as reads
  return JSON.parse(body.string as string) as Record<string, unknown>
}

async function backendApply(r: ProviderRef, w: ProviderWrite): Promise<ProviderWriteResult> {
  const auth = authFor(requireStore(), r.connectionId)
  const name = r.path
  const ctx = `Secrets Manager ${name}`
  const api = apiFor(auth, ctx)
  // Re-read right before the put: current version + timestamp are the base.
  const [meta, cur] = await Promise.all([
    aws(ctx, auth, () => api.describe(name)),
    aws(ctx, auth, () => api.get(name))
  ])
  if (!meta) throw new Error(`${ctx}: not found`)
  if (w.expectedMtime > 0 && meta.lastChanged !== w.expectedMtime)
    throw new Error(`${ctx} changed since this plan was made. Rescan, compare again, then apply.`)
  const doc = secretObject(name, cur)
  for (const e of w.entries) doc[e.key] = e.value
  const put = await aws(ctx, auth, () => api.put(name, JSON.stringify(doc), w.token))
  const written = w.entries.map((e) => e.key)
  const [stages, back, after] = await Promise.all([
    aws(ctx, auth, () => api.stages(name)),
    aws(ctx, auth, () => api.get(name, put.versionId)),
    aws(ctx, auth, () => api.describe(name))
  ])
  const version = { base: meta.lastChanged, next: after?.lastChanged ?? meta.lastChanged }
  const previous = Object.entries(stages).find(([, labels]) => labels.includes('AWSPREVIOUS'))?.[0]
  const raced = cur.versionId !== undefined && previous !== undefined && previous !== cur.versionId
  const backDoc = secretObject(name, back)
  const missing = unconfirmed(w.entries, (k) =>
    typeof backDoc[k] === 'string' ? (backDoc[k] as string) : null
  )
  if (raced)
    return {
      written,
      verified: false,
      version,
      note: `Another write landed on ${name} between Drift's re-read and this write (AWSPREVIOUS is not the version this plan was built on). The new version ${put.versionId} holds this plan's values on top of the OLDER content; review the secret in AWS before relying on it.`
    }
  if (missing.length)
    return {
      written,
      verified: false,
      version,
      note: `Read-back of version ${put.versionId} did not confirm ${missing.join(', ')}. Check the secret in AWS before relying on it.`
    }
  return {
    written,
    verified: true,
    version,
    note: `New version ${put.versionId} is AWSCURRENT; ${written.length} value${written.length === 1 ? '' : 's'} confirmed by read-back. Consumers pick it up on their next fetch (ECS tasks at their next start).`
  }
}

async function backendStat(r: ProviderRef): Promise<Stat> {
  const auth = authFor(requireStore(), r.connectionId)
  const ctx = `Secrets Manager ${r.path}`
  const d = await aws(ctx, auth, () => apiFor(auth, ctx).describe(r.path))
  if (!d) throw new Error(`${ctx}: not found`)
  return { mtimeMs: d.lastChanged, size: 0 }
}

type Mode = 'secret' | 'prefix'
type Found = { name: string; lastChanged: number }

/** Every secret under `prefix/`, every page. */
async function listPrefix(api: SmApi, auth: AwsAuth, secret: string): Promise<Found[]> {
  const ctx = `Secrets Manager ${secret}`
  const prefix = secret.endsWith('/') ? secret : `${secret}/`
  const out: Found[] = []
  let token: string | undefined
  for (let page = 0; ; page++) {
    if (page >= MAX_PAGES)
      throw new Error(
        `${ctx}: more than ${MAX_PAGES * 100} secrets under ${prefix}; narrow the prefix so the scan can be complete.`
      )
    const r = await aws(ctx, auth, () => api.list(prefix, token))
    out.push(...r.items)
    token = r.nextToken
    if (!token) return out
  }
}

/**
 * Resolve what a source names. A trailing slash is an explicit prefix; without
 * one, an existing secret of that name wins, otherwise the prefix. The mode is
 * persisted on the connection (refs cannot carry the slash), so a rescan never
 * reinterprets `prod/` as a secret called `prod`.
 */
async function resolve(
  api: SmApi,
  auth: AwsAuth,
  secret: string,
  mode?: Mode
): Promise<{ mode: Mode; found: Found[] }> {
  const m: Mode | undefined = mode ?? (secret.endsWith('/') ? 'prefix' : undefined)
  if (m !== 'prefix') {
    const ctx = `Secrets Manager ${secret}`
    const one = await aws(ctx, auth, () => api.describe(secret))
    if (one) return { mode: 'secret', found: [one] }
    if (m === 'secret') return { mode: 'secret', found: [] }
  }
  return { mode: 'prefix', found: await listPrefix(api, auth, secret) }
}

async function backendScan(root: string, r: ProviderRef): Promise<ScanResult> {
  const started = performance.now()
  const store = requireStore()
  const auth = authFor(store, r.connectionId)
  const api = apiFor(auth, `Secrets Manager ${r.path}`)
  const mode = connectionFor(store, r.connectionId, 'aws-sm').config['mode'] as Mode | undefined
  const { found, mode: resolved } = await resolve(api, auth, r.path, mode)
  const isPrefix = resolved === 'prefix'
  const prefix = isPrefix ? `${r.path}/` : posix.dirname(r.path)
  const files: EnvFileInfo[] = found.map((s) => ({
    path: providerRef('aws-sm', r.connectionId, s.name),
    root,
    rel: isPrefix ? s.name.slice(prefix.length) : posix.basename(s.name),
    name: posix.basename(s.name),
    project: prefix.replace(/\/+$/, '') || auth.region,
    modifiedAt: s.lastChanged,
    size: 0
  }))
  return finish(root, files, 1, started)
}

/**
 * Whether a root names a folder of secrets. The ref cannot carry the trailing
 * slash, so main attaches this to RootInfo and Update source rebuilds `prefix/`
 * from it instead of guessing from the path.
 */
export function isPrefixSource(store: Store, ref: string): boolean {
  const r = parseRef(ref)
  if (r.kind !== 'provider' || r.provider !== 'aws-sm') return false
  return store.getConnection(r.connectionId)?.config['mode'] === 'prefix'
}

export function registerSecretsManager(store: Store): void {
  storeRef = store
  registerProviderBackend('aws-sm', {
    readEnv: backendReadEnv,
    readText: (r) => backendReadEnv(r).then((e) => e.text),
    stat: backendStat,
    scan: backendScan,
    apply: backendApply
  })
}

export async function connectSecretsManager(
  store: Store,
  spec: Extract<ProviderConnectSpec, { provider: 'aws-sm' }>
): Promise<ProviderConnectResult> {
  const auth: AwsAuth = { region: spec.region, profile: spec.profile?.trim() || null }
  const secret = spec.secret.trim().replace(/^\/+/, '')
  const { mode, found } = await resolve(apiFor(auth, `Secrets Manager ${secret}`), auth, secret)
  if (found.length === 0)
    throw new Error(
      `Secrets Manager (${auth.region}${auth.profile ? `, profile ${auth.profile}` : ''}): no secret named ${secret} and none start with ${secret.endsWith('/') ? secret : `${secret}/`}.`
    )
  const label = spec.name.trim() || `aws-sm:${secret}`
  // No credential: the SDK chain resolves it on every call. Only region, profile and mode are kept.
  const saved = saveConnection(
    store,
    'aws-sm',
    label,
    { region: auth.region, profile: auth.profile, mode },
    null,
    'session'
  )
  return {
    root: {
      path: providerRef('aws-sm', saved.id, secret),
      kind: 'aws-sm',
      label,
      ...(mode === 'prefix' ? { prefix: true as const } : {})
    },
    summary: `${found.length} secret${found.length === 1 ? '' : 's'} in ${auth.region} · JSON object secrets only`,
    warnings: []
  }
}
