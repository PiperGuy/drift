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

/**
 * Railway variables, read-only. One project = one source. Each environment
 * gives a shared-variables file (`.env.<environment>`) and one file per service
 * (`<service>/.env.<environment>`). Values come back resolved from the
 * `variables` query.
 *
 * API (docs.railway.com/reference/public-api, checked 2026-09): GraphQL at
 * /graphql/v2, Bearer account or team token. Project tokens are scoped to one
 * environment and use a different header; not supported here.
 */
export const RAILWAY_API = 'https://backboard.railway.com'
type Cfg = { baseUrl: string; projectId: string; projectName: string }
type Node = { id: string; name: string }
type Project = Node & { environments: Node[]; services: Node[] }

let storeRef: Store | null = null
const requireStore = (): Store => {
  if (!storeRef) throw new Error('Railway sources are only available inside the Drift app.')
  return storeRef
}
const api = (baseUrl: string, token: string): ApiConfig => ({
  baseUrl,
  headers: { Authorization: `Bearer ${token}` }
})
const cfgFor = (store: Store, id: number): { cfg: Cfg; a: ApiConfig } => {
  const conn = connectionFor(store, id, 'railway')
  const cfg = conn.config as Cfg
  return { cfg, a: api(cfg.baseUrl, secretFor(store, id, 'railway')) }
}

async function gql<T>(
  a: ApiConfig,
  query: string,
  variables: Record<string, string | undefined>,
  context: string
): Promise<T> {
  const r = expectJson(
    await apiRequest(a, { method: 'POST', path: '/graphql/v2', body: { query, variables } }),
    context
  ) as { data?: T; errors?: { message?: string }[] }
  if (r.errors?.length) {
    const msg = r.errors
      .map((e) => e.message ?? '')
      .filter(Boolean)
      .join('; ')
      .slice(0, 200)
    if (/not authorized|unauthorized|unauthenticated/i.test(msg))
      throw new ProviderError('unauthorized', `${context}: ${msg}. Check the token.`)
    if (/not found/i.test(msg)) throw new ProviderError('not-found', `${context}: ${msg}`)
    throw new ProviderError('http', `${context}: ${msg || 'GraphQL error'}`)
  }
  if (!r.data) throw new ProviderError('malformed', `${context}: no data in the response.`)
  return r.data
}

const edges = <T>(c: { edges?: { node: T }[] } | undefined): T[] =>
  (c?.edges ?? []).map((e) => e.node)

async function project(a: ApiConfig, id: string): Promise<Project> {
  const d = await gql<{
    project: {
      id: string
      name: string
      environments?: { edges: { node: Node }[] }
      services?: { edges: { node: Node }[] }
    } | null
  }>(
    a,
    `query ($id: String!) { project(id: $id) { id name environments { edges { node { id name } } } services { edges { node { id name } } } } }`,
    { id },
    'Railway project'
  )
  if (!d.project) throw new ProviderError('not-found', 'Railway project: not found.')
  return {
    id: d.project.id,
    name: d.project.name,
    environments: edges(d.project.environments),
    services: edges(d.project.services)
  }
}

async function variables(
  a: ApiConfig,
  cfg: Cfg,
  environmentId: string,
  serviceId: string | null
): Promise<Record<string, unknown>> {
  const d = await gql<{ variables: unknown }>(
    a,
    `query ($projectId: String!, $environmentId: String!, $serviceId: String) { variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId) }`,
    { projectId: cfg.projectId, environmentId, serviceId: serviceId ?? undefined },
    `Railway ${cfg.projectName} variables`
  )
  if (d.variables === null || typeof d.variables !== 'object' || Array.isArray(d.variables))
    throw new ProviderError('malformed', 'Railway returned variables that are not a JSON object.')
  return d.variables as Record<string, unknown>
}

/** File path under the root: `<envId>/<serviceId|_>/.env.<envName>`. */
function parseFile(r: ProviderRef): {
  environmentId: string
  serviceId: string | null
  envName: string
} {
  const m = /^[^/]+\/([^/]+)\/([^/]+)\/\.env\.(.+)$/.exec(r.path)
  if (!m) throw new Error(`${r.path}: not a Railway environment file`)
  return {
    environmentId: m[1],
    serviceId: m[2] === '_' ? null : m[2],
    envName: decodeURIComponent(m[3])
  }
}

async function backendReadEnv(r: ProviderRef): Promise<EnvRead> {
  const { cfg, a } = cfgFor(requireStore(), r.connectionId)
  const f = parseFile(r)
  const vars = await variables(a, cfg, f.environmentId, f.serviceId)
  return renderEnv(
    [
      `railway:${cfg.projectName} ${f.envName}${f.serviceId ? ` service ${f.serviceId}` : ' (shared)'} · values live in Railway`
    ],
    Object.entries(vars).map(([key, v]) => ({
      key,
      value: typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v)
    }))
  )
}

// Railway exposes no per-variable timestamp: the write guard is moot (read-only).
const backendStat = async (): Promise<Stat> => ({ mtimeMs: 0, size: 0 })

async function backendScan(root: string, r: ProviderRef): Promise<ScanResult> {
  const started = performance.now()
  const { cfg, a } = cfgFor(requireStore(), r.connectionId)
  const p = await project(a, cfg.projectId)
  const files: EnvFileInfo[] = []
  const file = (env: Node, svc: Node | null): EnvFileInfo => ({
    path: providerRef(
      'railway',
      r.connectionId,
      `${cfg.projectId}/${env.id}/${svc?.id ?? '_'}/.env.${encodeURIComponent(env.name)}`
    ),
    root,
    rel: `${svc ? `${svc.name}/` : ''}.env.${env.name}`,
    name: `.env.${env.name}`,
    project: svc ? `${p.name}/${svc.name}` : p.name,
    modifiedAt: 0,
    size: 0
  })
  for (const env of p.environments) {
    files.push(file(env, null))
    for (const svc of p.services) files.push(file(env, svc))
  }
  return finish(root, files, 1, started)
}

export function registerRailway(store: Store): void {
  storeRef = store
  registerProviderBackend('railway', {
    readEnv: backendReadEnv,
    readText: (r) => backendReadEnv(r).then((e) => e.text),
    stat: backendStat,
    scan: backendScan
  })
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function connectRailway(
  store: Store,
  spec: Extract<ProviderConnectSpec, { provider: 'railway' }>,
  baseUrl = RAILWAY_API
): Promise<ProviderConnectResult> {
  const token = spec.token.trim()
  const a = api(baseUrl, token)
  const want = spec.project.trim()
  let id = want
  if (!UUID.test(want)) {
    const d = await gql<{ me: { projects?: { edges: { node: Node }[] } } }>(
      a,
      `query { me { projects { edges { node { id name } } } } }`,
      {},
      'Railway projects'
    )
    const hit = edges(d.me?.projects).find((n) => n.name === want || n.id === want)
    if (!hit)
      throw new ProviderError(
        'not-found',
        `Railway project "${want}": not found among your projects (use the project id from its settings for team projects).`
      )
    id = hit.id
  }
  const p = await project(a, id)
  const cfg: Cfg = { baseUrl, projectId: p.id, projectName: p.name }
  const label = spec.name.trim() || `railway:${p.name}`
  const saved = saveConnection(store, 'railway', label, cfg, token, spec.storage)
  return {
    root: { path: providerRef('railway', saved.id, p.id), kind: 'railway', label },
    summary: `${p.environments.length} environment${p.environments.length === 1 ? '' : 's'} · ${p.services.length} service${p.services.length === 1 ? '' : 's'} · read-only`,
    warnings: saved.warning ? [saved.warning] : []
  }
}
