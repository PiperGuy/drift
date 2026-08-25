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
    req.on('error', (e) => reject(new Error(`Vault unreachable at ${base.host}: ${e.message}`)))
    req.on('response', (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
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
    { method: 'GET', path: '/v1/sys/health', noNamespace: true, timeoutMs: 10_000 }
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
  const r = await vaultRequest(cfg, { method: 'GET', path: '/v1/auth/token/lookup-self' })
  return toTokenInfo(expectOk(r, 'token lookup'))
}

export async function renewSelf(cfg: VaultConfig): Promise<TokenInfo> {
  const r = await vaultRequest(cfg, { method: 'POST', path: '/v1/auth/token/renew-self' })
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
    body: { role_id: roleId, secret_id: secretId }
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
    body: { paths }
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

/**
 * Which mount a full path (mount included) lives on, and whether it is KV v2.
 * Tries sys/internal/ui/mounts/:path (explicitly unstable API), then falls back
 * to reading <first-segment>/config, which only a KV v2 mount answers.
 */
export async function mountFor(
  cfg: VaultConfig,
  fullPath: string
): Promise<{ mount: string; kvVersion: '1' | '2' | 'unknown'; config: MountConfig | null }> {
  const first = fullPath.split('/')[0]
  const r = await vaultRequest(cfg, {
    method: 'GET',
    path: `/v1/sys/internal/ui/mounts/${encodePath(fullPath)}`
  })
  if (r.status === 200) {
    const d = (r.json?.['data'] as Record<string, unknown>) ?? {}
    const mount = String(d['path'] ?? `${first}/`).replace(/\/+$/, '')
    const isKv2 =
      d['type'] === 'kv' && (d['options'] as Record<string, unknown> | null)?.['version'] === '2'
    if (!isKv2) return { mount, kvVersion: d['type'] === 'kv' ? '1' : 'unknown', config: null }
    const c = await vaultRequest(cfg, { method: 'GET', path: `/v1/${encodePath(mount)}/config` })
    return {
      mount,
      kvVersion: '2',
      config:
        c.status === 200 ? toMountConfig((c.json?.['data'] as Record<string, unknown>) ?? {}) : null
    }
  }
  // Unstable endpoint unavailable: only a KV v2 mount answers /config with max_versions.
  const c = await vaultRequest(cfg, { method: 'GET', path: `/v1/${encodePath(first)}/config` })
  if (
    c.status === 200 &&
    (c.json?.['data'] as Record<string, unknown>)?.['max_versions'] !== undefined
  )
    return {
      mount: first,
      kvVersion: '2',
      config: toMountConfig((c.json?.['data'] as Record<string, unknown>) ?? {})
    }
  return { mount: first, kvVersion: 'unknown', config: null }
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
  folder: string
): Promise<{ keys: string[] } | { empty: true }> {
  const p = folder
    ? `${encodePath(mount)}/metadata/${encodePath(folder)}`
    : `${encodePath(mount)}/metadata`
  const r = await vaultRequest(cfg, { method: 'GET', path: `/v1/${p}?list=true` })
  // Empty and permission-denied both answer 404 {"errors":[]}; Vault does not say which.
  if (r.status === 404) return { empty: true }
  const d = expectOk(r, 'list')
  return { keys: ((d['keys'] as string[]) ?? []).slice().sort() }
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
  path: string
): Promise<MetadataBody | null> {
  const r = await vaultRequest(cfg, {
    method: 'GET',
    path: `/v1/${encodePath(mount)}/metadata/${encodePath(path)}`
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
    body: { token }
  })
  return (
    r.status === 200 && Boolean((r.json?.['data'] as Record<string, unknown>)?.['creation_path'])
  )
}

export async function unwrap(cfg: VaultConfig, wrappingToken: string): Promise<string> {
  const r = await vaultRequest(
    { ...cfg, token: wrappingToken },
    { method: 'POST', path: '/v1/sys/wrapping/unwrap' }
  )
  if (r.status !== 200) throw new VaultHttpError(r.status, errorsOf(r), 'unwrap')
  const auth = r.json?.['auth'] as Record<string, unknown> | undefined
  const token = auth?.['client_token'] as string | undefined
  if (!token) throw new Error('The wrapped response did not contain a token.')
  return token
}
