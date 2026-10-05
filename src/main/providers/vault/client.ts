import { request as httpsRequest, Agent as HttpsAgent } from 'node:https'
import { request as httpRequest } from 'node:http'

/**
 * Minimal Vault HTTP API client. Pure node:https/http (no SDK exists for JS,
 * and fetch() cannot carry a custom CA without an extra dependency). Everything
 * is plain JSON under /v1/. Never logs URLs, bodies or tokens.
 *
 * Facts this client relies on (developer.hashicorp.com, verified 2026-08-24):
 *  - token header X-Vault-Token, namespace header X-Vault-Namespace
 *  - LIST is a real HTTP verb; empty list = 404 {"errors":[]}
 *  - errors always come back as {"errors": ["...", ...]}
 *  - KV v2 reads of deleted/destroyed versions return 404 WITH a body carrying
 *    data.metadata (deletion_time / destroyed) — a 404 is not proof of absence
 *  - CAS mismatch is HTTP 400 with "check-and-set parameter did not match the
 *    current version" in errors[]
 */

export type VaultConfig = {
  /** e.g. https://vault.example.internal:8200 — http:// only for loopback. */
  address: string
  /** Enterprise / HCP only (HCP Vault Dedicated: "admin" or "admin/<child>"). */
  namespace?: string
  caPem?: string
  serverName?: string
  token?: string
  userAgent: string
}

export type VaultResponse = { status: number; json: Record<string, unknown> | null }

export class VaultHttpError extends Error {
  constructor(
    public status: number,
    public errors: string[],
    context: string
  ) {
    super(`Vault ${context}: HTTP ${status}${errors.length ? ` — ${errors.join('; ')}` : ''}`)
  }
}

/**
 * Cap for sign-in and token calls (health, lookup/renew, AppRole, wrapping,
 * capabilities): their answers are a few KB. KV data reads and writes stay
 * uncapped, so no secret Vault accepted (operators can raise max_request_size)
 * is refused; discovery passes its own cap.
 */
const SIGN_IN_BYTES = 1024 * 1024

const LOOPBACK = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i

export function assertAddress(address: string): URL {
  let u: URL
  try {
    u = new URL(address)
  } catch {
    throw new Error(`Not a valid URL: ${address}`)
  }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOOPBACK.test(address)))
    throw new Error('Vault address must be https:// (plain http is allowed only on loopback).')
  return u
}

export async function vaultRequest(
  cfg: VaultConfig,
  opts: {
    method: string
    /** Path under the API root, starting with /v1/. */
    path: string
    body?: unknown
    headers?: Record<string, string>
    /** sys/health must be asked in the root namespace. */
    noNamespace?: boolean
    timeoutMs?: number
    /** Abort (as an error) once the response body exceeds this many bytes. */
    maxBytes?: number
  }
): Promise<VaultResponse> {
  const base = assertAddress(cfg.address)
  const headers: Record<string, string> = {
    'X-Vault-Request': 'true',
    'User-Agent': cfg.userAgent,
    ...opts.headers
  }
  if (cfg.token) headers['X-Vault-Token'] = cfg.token
  if (cfg.namespace && !opts.noNamespace) headers['X-Vault-Namespace'] = cfg.namespace
  let payload: Buffer | null = null
  if (opts.body !== undefined) {
    payload = Buffer.from(JSON.stringify(opts.body), 'utf8')
    headers['Content-Type'] = 'application/json'
    headers['Content-Length'] = String(payload.length)
  }

  return new Promise<VaultResponse>((resolvePromise, reject) => {
    const common = {
      method: opts.method,
      host: base.hostname,
      port: base.port || (base.protocol === 'https:' ? 443 : 80),
      path: (base.pathname === '/' ? '' : base.pathname) + opts.path,
      headers,
      timeout: opts.timeoutMs ?? 30_000
    }
    const req =
      base.protocol === 'https:'
        ? httpsRequest({
            ...common,
            agent: new HttpsAgent({ ca: cfg.caPem || undefined }),
            servername: cfg.serverName || undefined
          })
        : httpRequest(common)
    req.on('timeout', () => {
      req.destroy(new Error('timed out'))
    })
    req.on('error', (e) =>
      reject(
        new Error(
          e.message === 'response too large'
            ? `Vault at ${base.host} answered with more data than Drift reads in one response.`
            : `Vault unreachable at ${base.host}: ${e.message}`
        )
      )
    )
    req.on('response', (res) => {
      const chunks: Buffer[] = []
      let size = 0
      res.on('data', (c: Buffer) => {
        size += c.length
        if (opts.maxBytes && size > opts.maxBytes) {
          req.destroy(new Error('response too large'))
          return
        }
        chunks.push(c)
      })
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json: Record<string, unknown> | null = null
        try {
          json = text ? (JSON.parse(text) as Record<string, unknown>) : null
        } catch {
          json = null
        }
        resolvePromise({ status: res.statusCode ?? 0, json })
      })
    })
    if (payload) req.write(payload)
    req.end()
  })
}

const errorsOf = (r: VaultResponse): string[] =>
  Array.isArray(r.json?.['errors']) ? (r.json['errors'] as string[]) : []

function expectOk(r: VaultResponse, context: string): Record<string, unknown> {
  if (r.status === 200 || r.status === 204)
    return (r.json?.['data'] as Record<string, unknown>) ?? {}
  throw new VaultHttpError(r.status, errorsOf(r), context)
}

// ---------- endpoints ----------

export type HealthBody = {
  initialized: boolean
  sealed: boolean
  standby: boolean
  version: string
  enterprise?: boolean
  cluster_name?: string
}

/** GET /sys/health — unauthenticated, root namespace, never throws on non-200. */
export async function health(
  cfg: VaultConfig
): Promise<{ status: number; body: HealthBody | null }> {
  const r = await vaultRequest(
    { ...cfg, token: undefined },
    {
      method: 'GET',
      path: '/v1/sys/health',
      noNamespace: true,
      timeoutMs: 10_000,
      maxBytes: SIGN_IN_BYTES
    }
  )
  return { status: r.status, body: (r.json as HealthBody | null) ?? null }
}

export type TokenInfo = {
  accessor: string
  displayName: string
  policies: string[]
  expireTime: string | null
  ttl: number
  renewable: boolean
  numUses: number
  type: 'service' | 'batch'
}

const toTokenInfo = (d: Record<string, unknown>): TokenInfo => ({
  accessor: String(d['accessor'] ?? ''),
  displayName: String(d['display_name'] ?? ''),
  policies: [
    ...new Set([
      ...((d['policies'] as string[]) ?? []),
      ...((d['identity_policies'] as string[]) ?? [])
    ])
  ],
  expireTime: (d['expire_time'] as string | null) ?? null,
  ttl: Number(d['ttl'] ?? 0),
  renewable: Boolean(d['renewable']),
  numUses: Number(d['num_uses'] ?? 0),
  type: (d['type'] as 'service' | 'batch') ?? 'service'
})

export async function lookupSelf(cfg: VaultConfig): Promise<TokenInfo> {
  const r = await vaultRequest(cfg, {
    method: 'GET',
    path: '/v1/auth/token/lookup-self',
    maxBytes: SIGN_IN_BYTES
  })
  return toTokenInfo(expectOk(r, 'token lookup'))
}

export async function renewSelf(cfg: VaultConfig): Promise<TokenInfo> {
  const r = await vaultRequest(cfg, {
    method: 'POST',
    path: '/v1/auth/token/renew-self',
    maxBytes: SIGN_IN_BYTES
  })
  if (r.status !== 200) throw new VaultHttpError(r.status, errorsOf(r), 'token renew')
  // The renewed TTL must be read from the response, not assumed.
  return lookupSelf(cfg)
}

export async function approleLogin(
  cfg: VaultConfig,
  roleId: string,
  secretId: string
): Promise<{ token: string }> {
  const r = await vaultRequest(cfg, {
    method: 'POST',
    path: '/v1/auth/approle/login',
    body: { role_id: roleId, secret_id: secretId },
    maxBytes: SIGN_IN_BYTES
  })
  if (r.status !== 200) throw new VaultHttpError(r.status, errorsOf(r), 'AppRole login')
  const auth = r.json?.['auth'] as Record<string, unknown> | undefined
  const token = auth?.['client_token'] as string | undefined
  if (!token) {
    // Two-phase Login MFA answers 200 with an empty client_token and an mfa_requirement.
    if (auth && auth['mfa_requirement'])
      throw new Error(
        'This Vault requires MFA on login, which Drift does not support yet. Run `vault login` in a terminal and paste the token instead.'
      )
    throw new Error('AppRole login returned no token')
  }
  return { token }
}

/** POST /sys/capabilities-self — per-path capability list ("deny" when denied). */
export async function capabilities(
  cfg: VaultConfig,
  paths: string[]
): Promise<Record<string, string[]>> {
  const r = await vaultRequest(cfg, {
    method: 'POST',
    path: '/v1/sys/capabilities-self',
    body: { paths },
    maxBytes: SIGN_IN_BYTES
  })
  const d = expectOk(r, 'capability check')
  const out: Record<string, string[]> = {}
  for (const p of paths) out[p] = (d[p] as string[]) ?? ['deny']
  return out
}

export type MountConfig = { casRequired: boolean; maxVersions: number; deleteVersionAfter: string }

const toMountConfig = (d: Record<string, unknown>): MountConfig => ({
  casRequired: Boolean(d['cas_required']),
  maxVersions: Number(d['max_versions'] ?? 0),
  deleteVersionAfter: String(d['delete_version_after'] ?? '0s')
})

/** Deepest mount nesting the fallback probes; Vault mounts are rarely deeper than this. */
const MAX_MOUNT_DEPTH = 8
/** LIST hops spent confirming a folder (descending to its first secret). */
const CONFIRM_HOPS = 3
/** Response cap for discovery and mount probing. */
const DISCOVERY_BYTES = 4 * 1024 * 1024

type Json = Record<string, unknown>
const obj = (v: unknown): Json | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null

/**
 * A KV v2 /config body: all three typed fields, which a KV v1 secret named
 * "config" lacks — and no version timeline, so the metadata of a KV v2 secret
 * named "config" (same three fields) cannot make `<mount>/metadata` look like a mount.
 */
const isKv2Config = (d: Json | null): d is Json =>
  typeof d?.['max_versions'] === 'number' &&
  typeof d['cas_required'] === 'boolean' &&
  typeof d['delete_version_after'] === 'string' &&
  !('current_version' in d) &&
  !('versions' in d)

/** A KV v2 metadata body: numeric versions plus a non-empty, numerically keyed timeline. */
const isKv2Metadata = (d: Json | null): boolean => {
  const versions = obj(d?.['versions'])
  return (
    typeof d?.['current_version'] === 'number' &&
    typeof d['oldest_version'] === 'number' &&
    versions !== null &&
    Object.keys(versions).length > 0 &&
    Object.keys(versions).every((k) => /^\d+$/.test(k))
  )
}

/**
 * Which mount a full path lives on, as Vault's own mount table says
 * (sys/internal/ui/mounts/:path, explicitly unstable API). Sends nothing to the
 * mount itself, so it can never read a secret value. Null when Vault would not say.
 */
export async function uiMount(
  cfg: VaultConfig,
  fullPath: string
): Promise<{ mount: string; kvVersion: '1' | '2' | 'unknown' } | null> {
  const r = await vaultRequest(cfg, {
    method: 'GET',
    path: `/v1/sys/internal/ui/mounts/${encodePath(fullPath)}`,
    maxBytes: DISCOVERY_BYTES
  })
  if (r.status !== 200) return null
  const d = obj(r.json?.['data']) ?? {}
  const mount = String(d['path'] ?? `${fullPath.split('/')[0]}/`).replace(/\/+$/, '')
  const kv = d['type'] === 'kv'
  return {
    mount,
    kvVersion: kv && obj(d['options'])?.['version'] === '2' ? '2' : kv ? '1' : 'unknown'
  }
}

/**
 * Which mount a full path (mount included) lives on, and whether it is KV v2.
 * Tries uiMount first. If that is denied, probes each leading prefix as a candidate mount (mounts may be
 * nested, e.g. teams/payments), shortest first; Vault forbids overlapping
 * mounts, so the first prefix that proves KV v2 is the mount:
 *  1. <prefix>/config shaped like KV v2 mount config;
 *  2. for tokens without config read: <prefix>/metadata/<rest> shaped like a
 *     KV v2 version timeline, or, for a folder, a LIST of it confirmed by the
 *     metadata of the first secret below it (at most CONFIRM_HOPS lists).
 * The strict shapes keep a KV v1 mount, whose `config` or `metadata/...` would
 * be ordinary secrets, from passing as KV v2. They stop accidental look-alikes, not
 * forgery: someone able to write KV v1 secrets shaped exactly like KV v2 answers
 * could pass. That needs write access to that Vault already, and any write that
 * follows still goes through a human-approved, check-and-set-guarded plan. Probe bodies stay in this
 * function and are capped in size; nothing from them is returned. On a KV v1 mount
 * these probes are secret reads, so Browse Vault never uses this (see uiMount); only
 * connecting a typed source path, which reads values anyway, does.
 */
export async function mountFor(
  cfg: VaultConfig,
  fullPath: string
): Promise<{ mount: string; kvVersion: '1' | '2' | 'unknown'; config: MountConfig | null }> {
  const get = (path: string): Promise<VaultResponse> =>
    vaultRequest(cfg, { method: 'GET', path, maxBytes: DISCOVERY_BYTES })
  const first = fullPath.split('/')[0]
  const ui = await uiMount(cfg, fullPath)
  if (ui) {
    const { mount } = ui
    if (ui.kvVersion !== '2') return { ...ui, config: null }
    const c = await get(`/v1/${encodePath(mount)}/config`)
    const cd = obj(c.json?.['data'])
    return { mount, kvVersion: '2', config: c.status === 200 && cd ? toMountConfig(cd) : null }
  }

  const segs = fullPath.split('/')
  const prefixes = segs
    .slice(0, MAX_MOUNT_DEPTH)
    .map((_, i) => ({ mount: segs.slice(0, i + 1).join('/'), rest: segs.slice(i + 1).join('/') }))
  for (const { mount } of prefixes) {
    const c = await get(`/v1/${encodePath(mount)}/config`)
    const d = obj(c.json?.['data'])
    if (c.status === 200 && isKv2Config(d))
      return { mount, kvVersion: '2', config: toMountConfig(d) }
  }
  const metadata = async (mount: string, path: string): Promise<boolean> => {
    const m = await get(`/v1/${encodePath(mount)}/metadata/${encodePath(path)}`)
    return m.status === 200 && isKv2Metadata(obj(m.json?.['data']))
  }
  /** A folder counts only once a secret below it shows a KV v2 timeline. */
  const folderConfirmed = async (mount: string, folder: string): Promise<boolean> => {
    for (let hop = 0; hop < CONFIRM_HOPS; hop++) {
      const l = await get(
        `/v1/${encodePath(mount)}/metadata${folder ? `/${encodePath(folder)}` : ''}?list=true`
      )
      const keys = obj(l.json?.['data'])?.['keys']
      if (l.status !== 200 || !Array.isArray(keys)) return false
      const names = keys.filter((k): k is string => typeof k === 'string' && k !== '')
      const join = (k: string): string => (folder ? `${folder}/${k}` : k)
      const leaf = names.find((k) => !k.endsWith('/'))
      if (leaf !== undefined) return metadata(mount, join(leaf))
      const sub = names.find((k) => k.endsWith('/'))
      if (sub === undefined) return false
      folder = join(sub.slice(0, -1))
    }
    return false
  }
  for (const { mount, rest } of prefixes) {
    if ((rest && (await metadata(mount, rest))) || (await folderConfirmed(mount, rest)))
      return { mount, kvVersion: '2', config: null }
  }
  return { mount: first, kvVersion: 'unknown', config: null }
}

export type MountEntry = { path: string; type: string; version: string; description: string }

const toMounts = (m: Record<string, unknown> | undefined): MountEntry[] =>
  Object.entries(m ?? {})
    .filter(([, v]) => v !== null && typeof v === 'object')
    .map(([path, v]) => {
      const o = v as Record<string, unknown>
      const opts = (o['options'] as Record<string, unknown> | null) ?? {}
      return {
        path: path.replace(/\/+$/, ''),
        type: String(o['type'] ?? ''),
        version: String(opts['version'] ?? ''),
        description: typeof o['description'] === 'string' ? o['description'] : ''
      }
    })

/**
 * Every secrets-engine mount the token may see. Tries the official GET /sys/mounts
 * (needs read on sys/mounts, e.g. a root or admin token) first, then
 * sys/internal/ui/mounts, which Vault filters to mounts the token has any
 * capability on (unstable API, but it is what the Vault UI itself uses).
 * Throws the last VaultHttpError when neither answers.
 */
export async function listMounts(
  cfg: VaultConfig
): Promise<{ source: 'sys/mounts' | 'ui'; mounts: MountEntry[] }> {
  const r = await vaultRequest(cfg, {
    method: 'GET',
    path: '/v1/sys/mounts',
    maxBytes: DISCOVERY_BYTES
  })
  if (r.status === 200) {
    // Older servers return the mounts at the top level, newer ones also under data.
    const d = (r.json?.['data'] as Record<string, unknown> | undefined) ?? r.json ?? {}
    return { source: 'sys/mounts', mounts: toMounts(d) }
  }
  const u = await vaultRequest(cfg, {
    method: 'GET',
    path: '/v1/sys/internal/ui/mounts',
    maxBytes: DISCOVERY_BYTES
  })
  if (u.status === 200) {
    const d = (u.json?.['data'] as Record<string, unknown> | undefined) ?? {}
    return { source: 'ui', mounts: toMounts(d['secret'] as Record<string, unknown> | undefined) }
  }
  throw new VaultHttpError(r.status, errorsOf(r), 'mount listing')
}

export type VersionMeta = {
  version: number
  createdTime: string
  deletionTime: string | null
  destroyed: boolean
  createdBy?: { actor?: string; operation?: string; entityId?: string }
}

const toVersionMeta = (n: number, v: Record<string, unknown>): VersionMeta => {
  const by = v['created_by'] as Record<string, unknown> | undefined
  return {
    version: n,
    createdTime: String(v['created_time'] ?? ''),
    deletionTime: (v['deletion_time'] as string) || null,
    destroyed: Boolean(v['destroyed']),
    ...(by
      ? {
          createdBy: {
            actor: by['actor'] as string | undefined,
            operation: by['operation'] as string | undefined,
            entityId: by['entity_id'] as string | undefined
          }
        }
      : {})
  }
}

const encodePath = (p: string): string => p.split('/').map(encodeURIComponent).join('/')

/**
 * List <mount>/metadata/<folder> — folders come back with a trailing slash.
 * Uses the documented `GET ?list=true` form of the LIST operation: the custom
 * LIST verb is not parseable by every HTTP stack (Node's own parser rejects it).
 */
export async function list(
  cfg: VaultConfig,
  mount: string,
  folder: string,
  maxBytes?: number
): Promise<{ keys: string[] } | { empty: true }> {
  const p = folder
    ? `${encodePath(mount)}/metadata/${encodePath(folder)}`
    : `${encodePath(mount)}/metadata`
  const r = await vaultRequest(cfg, {
    method: 'GET',
    path: `/v1/${p}?list=true`,
    maxBytes,
    timeoutMs: maxBytes ? 15_000 : undefined
  })
  // Empty and permission-denied both answer 404 {"errors":[]}; Vault does not say which.
  if (r.status === 404) return { empty: true }
  const d = expectOk(r, 'list')
  const keys = Array.isArray(d['keys']) ? d['keys'] : []
  return { keys: keys.filter((k): k is string => typeof k === 'string').sort() }
}

export type MetadataBody = {
  currentVersion: number
  oldestVersion: number
  updatedTime: string
  createdTime: string
  maxVersions: number
  casRequired: boolean
  deleteVersionAfter: string
  customMetadata: Record<string, string> | null
  versions: VersionMeta[]
}

export async function readMetadata(
  cfg: VaultConfig,
  mount: string,
  path: string,
  /** Discovery passes a cap: a secret with a huge version history must not be buffered whole. */
  maxBytes?: number
): Promise<MetadataBody | null> {
  const r = await vaultRequest(cfg, {
    method: 'GET',
    path: `/v1/${encodePath(mount)}/metadata/${encodePath(path)}`,
    maxBytes
  })
  if (r.status === 404) return null
  const d = expectOk(r, 'metadata read')
  const versions = Object.entries((d['versions'] as Record<string, Record<string, unknown>>) ?? {})
    .map(([n, v]) => toVersionMeta(Number(n), v))
    .sort((a, b) => b.version - a.version)
  return {
    currentVersion: Number(d['current_version'] ?? 0),
    oldestVersion: Number(d['oldest_version'] ?? 0),
    updatedTime: String(d['updated_time'] ?? ''),
    createdTime: String(d['created_time'] ?? ''),
    maxVersions: Number(d['max_versions'] ?? 0),
    casRequired: Boolean(d['cas_required']),
    deleteVersionAfter: String(d['delete_version_after'] ?? '0s'),
    customMetadata: (d['custom_metadata'] as Record<string, string> | null) ?? null,
    versions
  }
}

export type ReadDataResult =
  | { kind: 'ok'; version: number; data: Record<string, unknown>; meta: VersionMeta }
  | { kind: 'deleted' | 'destroyed'; meta: VersionMeta }
  | { kind: 'absent' }

export async function readData(
  cfg: VaultConfig,
  mount: string,
  path: string,
  version?: number
): Promise<ReadDataResult> {
  const q = version !== undefined ? `?version=${version}` : ''
  const r = await vaultRequest(cfg, {
    method: 'GET',
    path: `/v1/${encodePath(mount)}/data/${encodePath(path)}${q}`
  })
  const d = r.json?.['data'] as Record<string, unknown> | null | undefined
  const rawMeta = d?.['metadata'] as Record<string, unknown> | undefined
  if (r.status === 200 && d) {
    const meta = toVersionMeta(Number(rawMeta?.['version'] ?? 0), rawMeta ?? {})
    return {
      kind: 'ok',
      version: meta.version,
      data: (d['data'] as Record<string, unknown>) ?? {},
      meta
    }
  }
  if (r.status === 404) {
    // Deleted/destroyed versions 404 WITH metadata in the body.
    if (rawMeta) {
      const meta = toVersionMeta(Number(rawMeta['version'] ?? 0), rawMeta)
      return { kind: meta.destroyed ? 'destroyed' : 'deleted', meta }
    }
    return { kind: 'absent' }
  }
  throw new VaultHttpError(r.status, errorsOf(r), 'data read')
}

export const CAS_MISMATCH = 'check-and-set parameter did not match the current version'

export type WriteResult =
  | { kind: 'ok'; meta: VersionMeta }
  | { kind: 'cas-mismatch' }
  | { kind: 'error'; status: number; errors: string[] }

export async function writeData(
  cfg: VaultConfig,
  mount: string,
  path: string,
  data: Record<string, unknown>,
  cas: number,
  correlationId?: string
): Promise<WriteResult> {
  const r = await vaultRequest(cfg, {
    method: 'POST',
    path: `/v1/${encodePath(mount)}/data/${encodePath(path)}`,
    body: { options: { cas }, data },
    headers: correlationId ? { 'X-Correlation-Id': correlationId } : undefined
  })
  if (r.status === 200) {
    const d = (r.json?.['data'] as Record<string, unknown>) ?? {}
    return { kind: 'ok', meta: toVersionMeta(Number(d['version'] ?? 0), d) }
  }
  const errs = errorsOf(r)
  if (r.status === 400 && errs.some((e) => e.includes('check-and-set')))
    return { kind: 'cas-mismatch' }
  return { kind: 'error', status: r.status, errors: errs }
}

/** sys/wrapping/lookup succeeds only for wrapping tokens; used to offer a one-time unwrap. */
export async function isWrappingToken(cfg: VaultConfig, token: string): Promise<boolean> {
  const r = await vaultRequest(cfg, {
    method: 'POST',
    path: '/v1/sys/wrapping/lookup',
    body: { token },
    maxBytes: SIGN_IN_BYTES
  })
  return (
    r.status === 200 && Boolean((r.json?.['data'] as Record<string, unknown>)?.['creation_path'])
  )
}

export async function unwrap(cfg: VaultConfig, wrappingToken: string): Promise<string> {
  const r = await vaultRequest(
    { ...cfg, token: wrappingToken },
    { method: 'POST', path: '/v1/sys/wrapping/unwrap', maxBytes: SIGN_IN_BYTES }
  )
  if (r.status !== 200) throw new VaultHttpError(r.status, errorsOf(r), 'unwrap')
  const auth = r.json?.['auth'] as Record<string, unknown> | undefined
  const token = auth?.['client_token'] as string | undefined
  if (!token) throw new Error('The wrapped response did not contain a token.')
  return token
}
