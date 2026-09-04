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
import { apiRequest, expectJson, ProviderError, type ApiConfig } from '../http'
import { connectionFor, saveConnection, secretFor } from '../connection'
import { renderEnv } from '../envtext'
import { assertAddress } from '../vault/client'

/**
 * Coolify application variables, read-only. Self-hosted: instance URL + API
 * token, optional custom CA. Each application gives `<name>/.env` and, when it
 * has preview-deployment variables, `<name>/.env.preview`. Values come back
 * from the API; a variable the API returns without a value is names-only.
 *
 * API (coolify.io/docs/api-reference, checked 2026-09): Bearer token under
 * /api/v1; GET /applications; GET /applications/{uuid}/envs.
 */
type Cfg = { address: string; caPem: string | null }
type App = { uuid: string; name?: string; updated_at?: string }
type Env = { key: string; value?: string | null; is_preview?: boolean; updated_at?: string }

let storeRef: Store | null = null
const requireStore = (): Store => {
  if (!storeRef) throw new Error('Coolify sources are only available inside the Drift app.')
  return storeRef
}
const api = (cfg: Cfg, token: string): ApiConfig => ({
  baseUrl: `${cfg.address}/api/v1`,
  headers: { Authorization: `Bearer ${token}` },
  caPem: cfg.caPem ?? undefined
})
const cfgFor = (store: Store, id: number): { cfg: Cfg; a: ApiConfig } => {
  const conn = connectionFor(store, id, 'coolify')
  const cfg = conn.config as Cfg
  return { cfg, a: api(cfg, secretFor(store, id, 'coolify')) }
}

async function applications(a: ApiConfig): Promise<App[]> {
  const r = expectJson(
    await apiRequest(a, { method: 'GET', path: '/applications' }),
    'Coolify applications'
  )
  if (!Array.isArray(r))
    throw new ProviderError(
      'malformed',
      'Coolify applications: expected a list (is this the instance URL?).'
    )
  return r as App[]
}

async function envs(a: ApiConfig, uuid: string): Promise<Env[]> {
  const r = expectJson(
    await apiRequest(a, { method: 'GET', path: `/applications/${encodeURIComponent(uuid)}/envs` }),
    `Coolify application ${uuid} variables`
  )
  if (!Array.isArray(r)) throw new ProviderError('malformed', 'Coolify variables: expected a list.')
  return r as Env[]
}

const parseFile = (r: ProviderRef): { uuid: string; preview: boolean } => {
  const m = /^([^/]+)\/\.env(\.preview)?$/.exec(r.path)
  if (!m) throw new Error(`${r.path}: not a Coolify application file`)
  return { uuid: m[1], preview: Boolean(m[2]) }
}

async function backendReadEnv(r: ProviderRef): Promise<EnvRead> {
  const { cfg, a } = cfgFor(requireStore(), r.connectionId)
  const f = parseFile(r)
  const list = (await envs(a, f.uuid)).filter((e) => Boolean(e.is_preview) === f.preview)
  return renderEnv(
    [
      `coolify:${new URL(cfg.address).host} ${f.uuid}${f.preview ? ' (preview deployments)' : ''} · values live in Coolify`
    ],
    list.map((e) => ({ key: e.key, value: typeof e.value === 'string' ? e.value : null }))
  )
}

async function backendStat(r: ProviderRef): Promise<Stat> {
  const { a } = cfgFor(requireStore(), r.connectionId)
  const f = parseFile(r)
  const list = (await envs(a, f.uuid)).filter((e) => Boolean(e.is_preview) === f.preview)
  return { mtimeMs: Math.max(0, ...list.map((e) => Date.parse(e.updated_at ?? '') || 0)), size: 0 }
}

async function backendScan(root: string, r: ProviderRef): Promise<ScanResult> {
  const started = performance.now()
  const { a } = cfgFor(requireStore(), r.connectionId)
  const files: EnvFileInfo[] = []
  for (const app of await applications(a)) {
    const name = app.name || app.uuid
    // ponytail: one envs call per application to learn whether a preview file exists; batch or lazy if an instance has 100+ apps.
    const list = await envs(a, app.uuid)
    const at = Math.max(
      Date.parse(app.updated_at ?? '') || 0,
      ...list.map((e) => Date.parse(e.updated_at ?? '') || 0)
    )
    const file = (suffix: string): EnvFileInfo => ({
      path: providerRef('coolify', r.connectionId, `${app.uuid}/.env${suffix}`),
      root,
      rel: `${name}/.env${suffix}`,
      name: `.env${suffix}`,
      project: name,
      modifiedAt: at,
      size: 0
    })
    files.push(file(''))
    if (list.some((e) => e.is_preview)) files.push(file('.preview'))
  }
  return finish(root, files, 1, started)
}

export function registerCoolify(store: Store): void {
  storeRef = store
  registerProviderBackend('coolify', {
    readEnv: backendReadEnv,
    readText: (r) => backendReadEnv(r).then((e) => e.text),
    stat: backendStat,
    scan: backendScan
  })
}

export async function connectCoolify(
  store: Store,
  spec: Extract<ProviderConnectSpec, { provider: 'coolify' }>
): Promise<ProviderConnectResult> {
  const token = spec.token.trim()
  const address = spec.address
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/api\/v1$/, '')
  const host = assertAddress(address).hostname
  const cfg: Cfg = { address, caPem: spec.caPem?.trim() || null }
  const list = await applications(api(cfg, token))
  const label = spec.name.trim() || `coolify:${host}`
  const saved = saveConnection(store, 'coolify', label, cfg, token, spec.storage)
  return {
    root: { path: providerRef('coolify', saved.id, ''), kind: 'coolify', label },
    summary: `${list.length} application${list.length === 1 ? '' : 's'} · read-only`,
    warnings: saved.warning ? [saved.warning] : []
  }
}
