import { finish, providerRef, registerProviderBackend, type ProviderRef, type Stat } from '../../fs'
import type { Store } from '../../store'
import type {
  EnvFileInfo,
  ProviderConnectResult,
  ProviderConnectSpec,
  ScanResult
} from '@shared/channels'
import { apiRequest, expectJson, ProviderError, type ApiConfig } from '../http'
import { connectionFor, saveConnection, secretFor } from '../connection'
import { assertAddress } from '../vault/client'

/**
 * Dokploy application variables, read-only. Self-hosted: instance URL + API
 * key, optional custom CA. Dokploy stores an application's environment as
 * `.env`-formatted text, which becomes the file body verbatim (with a header).
 * Files: `<project>/<application>/.env`, or `<project>/<environment>/<application>/.env`
 * on Dokploy versions with environments.
 *
 * API (docs.dokploy.com/docs/api, checked 2026-09): header `x-api-key`;
 * GET /api/project.all; GET /api/application.one?applicationId=…
 */
type Cfg = { address: string; caPem: string | null }
type App = { applicationId: string; name?: string; appName?: string }
type Project = {
  projectId: string
  name?: string
  applications?: App[]
  environments?: { environmentId: string; name?: string; applications?: App[] }[]
}

let storeRef: Store | null = null
const requireStore = (): Store => {
  if (!storeRef) throw new Error('Dokploy sources are only available inside the Drift app.')
  return storeRef
}
const api = (cfg: Cfg, token: string): ApiConfig => ({
  baseUrl: cfg.address,
  headers: { 'x-api-key': token },
  caPem: cfg.caPem ?? undefined
})
const cfgFor = (store: Store, id: number): { cfg: Cfg; a: ApiConfig } => {
  const conn = connectionFor(store, id, 'dokploy')
  const cfg = conn.config as Cfg
  return { cfg, a: api(cfg, secretFor(store, id, 'dokploy')) }
}

async function projects(a: ApiConfig): Promise<Project[]> {
  const r = expectJson(
    await apiRequest(a, { method: 'GET', path: '/api/project.all' }),
    'Dokploy projects'
  )
  if (!Array.isArray(r))
    throw new ProviderError(
      'malformed',
      'Dokploy projects: expected a list (is this the instance URL?).'
    )
  return r as Project[]
}

/** Every application with its display path, across both project shapes. */
function apps(list: Project[]): { id: string; rel: string }[] {
  const out: { id: string; rel: string }[] = []
  for (const p of list) {
    const pn = p.name || p.projectId
    for (const a of p.applications ?? [])
      out.push({ id: a.applicationId, rel: `${pn}/${a.name || a.appName || a.applicationId}` })
    for (const e of p.environments ?? [])
      for (const a of e.applications ?? [])
        out.push({
          id: a.applicationId,
          rel: `${pn}/${e.name || e.environmentId}/${a.name || a.appName || a.applicationId}`
        })
  }
  return out
}

async function backendReadText(r: ProviderRef): Promise<string> {
  const { cfg, a } = cfgFor(requireStore(), r.connectionId)
  const m = /^([^/]+)\/\.env$/.exec(r.path)
  if (!m) throw new Error(`${r.path}: not a Dokploy application file`)
  const app = expectJson(
    await apiRequest(a, {
      method: 'GET',
      path: '/api/application.one',
      query: { applicationId: m[1] }
    }),
    `Dokploy application ${m[1]}`
  ) as { env?: string | null; name?: string; appName?: string }
  const env = typeof app.env === 'string' ? app.env : ''
  const body = env === '' || env.endsWith('\n') ? env : env + '\n'
  return `# dokploy:${new URL(cfg.address).host} ${app.name || app.appName || m[1]} · values live in Dokploy\n${body}`
}

const backendStat = async (): Promise<Stat> => ({ mtimeMs: 0, size: 0 })

async function backendScan(root: string, r: ProviderRef): Promise<ScanResult> {
  const started = performance.now()
  const { a } = cfgFor(requireStore(), r.connectionId)
  const files: EnvFileInfo[] = apps(await projects(a)).map((app) => ({
    path: providerRef('dokploy', r.connectionId, `${app.id}/.env`),
    root,
    rel: `${app.rel}/.env`,
    name: '.env',
    project: app.rel,
    modifiedAt: 0,
    size: 0
  }))
  return finish(root, files, 1, started)
}

export function registerDokploy(store: Store): void {
  storeRef = store
  registerProviderBackend('dokploy', {
    readText: backendReadText,
    stat: backendStat,
    scan: backendScan
  })
}

export async function connectDokploy(
  store: Store,
  spec: Extract<ProviderConnectSpec, { provider: 'dokploy' }>
): Promise<ProviderConnectResult> {
  const token = spec.token.trim()
  const address = spec.address
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/api$/, '')
  const host = assertAddress(address).hostname
  const cfg: Cfg = { address, caPem: spec.caPem?.trim() || null }
  const list = await projects(api(cfg, token))
  const all = apps(list)
  const label = spec.name.trim() || `dokploy:${host}`
  const saved = saveConnection(store, 'dokploy', label, cfg, token, spec.storage)
  return {
    root: { path: providerRef('dokploy', saved.id, ''), kind: 'dokploy', label },
    summary: `${list.length} project${list.length === 1 ? '' : 's'} · ${all.length} application${all.length === 1 ? '' : 's'} · read-only`,
    warnings: saved.warning ? [saved.warning] : []
  }
}
