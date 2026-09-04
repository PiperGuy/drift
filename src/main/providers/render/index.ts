import {
  finish,
  providerRef,
  registerProviderBackend,
  type EnvRead,
  type ProviderRef,
  type Stat
} from '../../fs'
import type { Store } from '../../store'
import type {
  EnvFileInfo,
  ProviderConnectResult,
  ProviderConnectSpec,
  ScanResult
} from '@shared/channels'
import { apiRequest, expectJson, paginate, ProviderError, type ApiConfig } from '../http'
import { connectionFor, saveConnection, secretFor } from '../connection'
import { renderEnv } from '../envtext'

/**
 * Render environment groups and service variables, read-only. One API key =
 * one source listing every env group (`env-groups/<name>/.env`) and service
 * (`services/<name>/.env`) the key can see. Values come back from the API.
 *
 * API (api-docs.render.com, checked 2026-09): Bearer key; list endpoints
 * return `[{ cursor, <item> }]` and page with `cursor` = last item's cursor.
 */
export const RENDER_API = 'https://api.render.com/v1'
type Cfg = { baseUrl: string; ownerName: string }
type Cursored<K extends string, T> = { cursor: string } & Record<K, T>

let storeRef: Store | null = null
const requireStore = (): Store => {
  if (!storeRef) throw new Error('Render sources are only available inside the Drift app.')
  return storeRef
}
const api = (baseUrl: string, token: string): ApiConfig => ({
  baseUrl,
  headers: { Authorization: `Bearer ${token}` }
})
const cfgFor = (store: Store, id: number): { cfg: Cfg; a: ApiConfig } => {
  const conn = connectionFor(store, id, 'render')
  const cfg = conn.config as Cfg
  return { cfg, a: api(cfg.baseUrl, secretFor(store, id, 'render')) }
}
const LIMIT = 100

async function listAll<K extends string, T>(
  a: ApiConfig,
  path: string,
  key: K,
  context: string
): Promise<T[]> {
  return paginate<T, string | undefined>(undefined, async (cursor) => {
    const r = expectJson(
      await apiRequest(a, { method: 'GET', path, query: { limit: String(LIMIT), cursor } }),
      context
    )
    if (!Array.isArray(r)) throw new ProviderError('malformed', `${context}: expected a list.`)
    const rows = r as Cursored<K, T>[]
    return {
      items: rows.map((x) => x[key]).filter((x) => x !== undefined),
      next: rows.length === LIMIT ? rows[rows.length - 1].cursor : null
    }
  })
}

type Service = { id: string; name: string; updatedAt?: string }
type Group = { id: string; name: string; updatedAt?: string }
type EnvVar = { key: string; value?: string }

const parseFile = (r: ProviderRef): { kind: 'services' | 'env-groups'; id: string } => {
  const m = /^(services|env-groups)\/([^/]+)\/\.env$/.exec(r.path)
  if (!m) throw new Error(`${r.path}: not a Render service or env group file`)
  return { kind: m[1] as 'services' | 'env-groups', id: m[2] }
}

async function backendReadEnv(r: ProviderRef): Promise<EnvRead> {
  const { a } = cfgFor(requireStore(), r.connectionId)
  const f = parseFile(r)
  if (f.kind === 'services') {
    const vars = await listAll<'envVar', EnvVar>(
      a,
      `/services/${encodeURIComponent(f.id)}/env-vars`,
      'envVar',
      `Render service ${f.id} variables`
    )
    return renderEnv(
      [`render:service ${f.id} · values live in Render`],
      vars.map((v) => ({ key: v.key, value: typeof v.value === 'string' ? v.value : null }))
    )
  }
  const g = expectJson(
    await apiRequest(a, { method: 'GET', path: `/env-groups/${encodeURIComponent(f.id)}` }),
    `Render env group ${f.id}`
  ) as { name?: string; envVars?: EnvVar[]; secretFiles?: { name?: string }[] }
  const files = (g.secretFiles ?? []).map((s) => s.name).filter((n): n is string => Boolean(n))
  return renderEnv(
    [
      `render:env group ${g.name ?? f.id} · values live in Render`,
      ...(files.length
        ? [
            `${files.length} secret file${files.length === 1 ? '' : 's'} not read: ${files.join(', ')}`
          ]
        : [])
    ],
    (g.envVars ?? []).map((v) => ({
      key: v.key,
      value: typeof v.value === 'string' ? v.value : null
    }))
  )
}

// Render's variable endpoints carry no timestamps: the source is read-only, so mtime is informational.
const backendStat = async (): Promise<Stat> => ({ mtimeMs: 0, size: 0 })

async function listBoth(a: ApiConfig): Promise<{ services: Service[]; groups: Group[] }> {
  const [services, groups] = await Promise.all([
    listAll<'service', Service>(a, '/services', 'service', 'Render services'),
    listAll<'envGroup', Group>(a, '/env-groups', 'envGroup', 'Render env groups')
  ])
  return { services, groups }
}

async function backendScan(root: string, r: ProviderRef): Promise<ScanResult> {
  const started = performance.now()
  const { a } = cfgFor(requireStore(), r.connectionId)
  const { services, groups } = await listBoth(a)
  const file = (kind: 'services' | 'env-groups', x: Service | Group): EnvFileInfo => ({
    path: providerRef('render', r.connectionId, `${kind}/${x.id}/.env`),
    root,
    rel: `${kind}/${x.name}/.env`,
    name: '.env',
    project: `${kind}/${x.name}`,
    modifiedAt: Date.parse(x.updatedAt ?? '') || 0,
    size: 0
  })
  return finish(
    root,
    [...groups.map((g) => file('env-groups', g)), ...services.map((s) => file('services', s))],
    1,
    started
  )
}

export function registerRender(store: Store): void {
  storeRef = store
  registerProviderBackend('render', {
    readEnv: backendReadEnv,
    readText: (r) => backendReadEnv(r).then((e) => e.text),
    stat: backendStat,
    scan: backendScan
  })
}

export async function connectRender(
  store: Store,
  spec: Extract<ProviderConnectSpec, { provider: 'render' }>,
  baseUrl = RENDER_API
): Promise<ProviderConnectResult> {
  const token = spec.token.trim()
  const a = api(baseUrl, token)
  const owners = await listAll<'owner', { id: string; name?: string }>(
    a,
    '/owners',
    'owner',
    'Render owners'
  )
  const ownerName =
    owners
      .map((o) => o.name)
      .filter(Boolean)
      .join(', ') || 'account'
  const { services, groups } = await listBoth(a)
  const cfg: Cfg = { baseUrl, ownerName }
  const label = spec.name.trim() || `render:${ownerName}`
  const saved = saveConnection(store, 'render', label, cfg, token, spec.storage)
  return {
    root: { path: providerRef('render', saved.id, ''), kind: 'render', label },
    summary: `${services.length} service${services.length === 1 ? '' : 's'} · ${groups.length} env group${groups.length === 1 ? '' : 's'} · read-only`,
    warnings: saved.warning ? [saved.warning] : []
  }
}
