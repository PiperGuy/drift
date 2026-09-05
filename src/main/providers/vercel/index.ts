import { posix } from 'node:path'
import {
  finish,
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
import { apiRequest, expectJson, paginate, ProviderError, type ApiConfig } from '../http'
import { connectionFor, saveConnection, secretFor } from '../connection'
import { renderEnv, type Entry } from '../envtext'
import { applyEach, verdict } from '../writekit'

/**
 * Vercel project environment variables. One project = one source; each target
 * (production / preview / development) is one environment "file", and
 * branch-scoped preview variables get `branches/<branch>/.env.preview`.
 * Values come back for plain and encrypted variables (`decrypt=true`, only when
 * a file is actually read); `sensitive` variables are reported by name only.
 *
 * API (vercel.com/docs/rest-api, checked 2026-09): Bearer token; team-owned
 * projects need `teamId`; GET /v9/projects/{idOrName}; GET
 * /v10/projects/{id}/env?decrypt=true, paginated with `until`.
 * Writes: PATCH /v9/projects/{id}/env/{envId} { value, type, target, gitBranch }
 * updates one variable; POST /v10/projects/{id}/env { key, value, type, target,
 * gitBranch } creates one (201 with `created` + `failed[]`). A variable that
 * spans several targets is split first (PATCH it to drop this file's target,
 * then POST a copy for this target) so a write to `.env.production` never
 * changes preview or development. `system` variables cannot be set.
 */
export const VERCEL_API = 'https://api.vercel.com'
const TARGETS = ['development', 'preview', 'production'] as const
type Target = (typeof TARGETS)[number]

type Var = {
  id: string
  key: string
  value?: string
  type: string
  target: string[]
  gitBranch?: string
  updatedAt?: number
}
type Cfg = { baseUrl: string; teamId: string | null; projectId: string; projectName: string }

let storeRef: Store | null = null
const requireStore = (): Store => {
  if (!storeRef) throw new Error('Vercel sources are only available inside the Drift app.')
  return storeRef
}

const api = (cfg: { baseUrl: string }, token: string): ApiConfig => ({
  baseUrl: cfg.baseUrl,
  headers: { Authorization: `Bearer ${token}` }
})

const cfgFor = (store: Store, id: number): { cfg: Cfg; token: string } => {
  const conn = connectionFor(store, id, 'vercel')
  return { cfg: conn.config as Cfg, token: secretFor(store, id, 'vercel') }
}

async function listVars(a: ApiConfig, cfg: Cfg, decrypt: boolean): Promise<Var[]> {
  return paginate<Var, string | undefined>(undefined, async (until) => {
    const r = expectJson(
      await apiRequest(a, {
        method: 'GET',
        path: `/v10/projects/${encodeURIComponent(cfg.projectId)}/env`,
        query: {
          teamId: cfg.teamId ?? undefined,
          decrypt: decrypt ? 'true' : undefined,
          until
        }
      }),
      `Vercel ${cfg.projectName} variables`
    ) as { envs?: Var[]; pagination?: { next?: number | null } }
    if (!Array.isArray(r.envs))
      throw new ProviderError('malformed', 'Vercel returned no `envs` list.')
    const next = r.pagination?.next
    return { items: r.envs, next: typeof next === 'number' ? String(next) : null }
  })
}

/** Which "file" a variable belongs to. A var may belong to several targets. */
const filesOf = (v: Var): string[] =>
  (v.target ?? [])
    .filter((t): t is Target => (TARGETS as readonly string[]).includes(t))
    .map((t) =>
      v.gitBranch && t === 'preview'
        ? `branches/${encodeURIComponent(v.gitBranch)}/.env.preview`
        : `.env.${t}`
    )

function parseFile(rel: string): { target: Target; branch: string | null } {
  const b = /^branches\/([^/]+)\/\.env\.preview$/.exec(rel)
  if (b) return { target: 'preview', branch: decodeURIComponent(b[1]) }
  const t = /^\.env\.(development|preview|production)$/.exec(rel)
  if (t) return { target: t[1] as Target, branch: null }
  throw new Error(`${rel}: unknown environment for a Vercel project`)
}

const belongs = (v: Var, f: { target: Target; branch: string | null }): boolean =>
  (v.target ?? []).includes(f.target) &&
  (f.target === 'preview' ? (v.gitBranch ?? null) === f.branch : true)

const relOf = (r: ProviderRef): string => r.path.split('/').slice(1).join('/')

/**
 * Every file a project exposes: the three targets always (an empty target is an
 * empty environment, not a missing one), plus one per branch-scoped preview.
 */
function fileSet(vars: Var[]): Map<string, number> {
  const seen = new Map<string, number>(TARGETS.map((t) => [`.env.${t}`, 0]))
  for (const v of vars)
    for (const f of filesOf(v)) seen.set(f, Math.max(seen.get(f) ?? 0, v.updatedAt ?? 0))
  return seen
}

async function backendReadEnv(r: ProviderRef): Promise<EnvRead> {
  const store = requireStore()
  const { cfg, token } = cfgFor(store, r.connectionId)
  const file = parseFile(relOf(r))
  const vars = (await listVars(api(cfg, token), cfg, true)).filter((v) => belongs(v, file))
  const entries: Entry[] = vars.map((v) => ({
    key: v.key,
    value: v.type === 'sensitive' || typeof v.value !== 'string' ? null : v.value
  }))
  return renderEnv(
    [
      `vercel:${cfg.projectName} ${file.target}${file.branch ? ` (branch ${file.branch})` : ''} · values live in Vercel`
    ],
    entries
  )
}

async function backendStat(r: ProviderRef): Promise<Stat> {
  const store = requireStore()
  const { cfg, token } = cfgFor(store, r.connectionId)
  const file = parseFile(relOf(r))
  const vars = (await listVars(api(cfg, token), cfg, false)).filter((v) => belongs(v, file))
  return { mtimeMs: Math.max(0, ...vars.map((v) => v.updatedAt ?? 0)), size: 0 }
}

type File = ReturnType<typeof parseFile>
const WRITABLE_TYPES = new Set(['encrypted', 'plain', 'sensitive'])
const scope = (f: File): { target: Target[]; gitBranch?: string } => ({
  target: [f.target],
  ...(f.branch ? { gitBranch: f.branch } : {})
})

async function backendApply(r: ProviderRef, w: ProviderWrite): Promise<ProviderWriteResult> {
  const store = requireStore()
  const { cfg, token } = cfgFor(store, r.connectionId)
  const a = api(cfg, token)
  const file = parseFile(relOf(r))
  const where = `Vercel ${cfg.projectName} ${file.target}${file.branch ? ` (branch ${file.branch})` : ''}`
  const envPath = `/v10/projects/${encodeURIComponent(cfg.projectId)}/env`
  const q = { teamId: cfg.teamId ?? undefined }
  // Re-read right before mutating: the newest timestamp must be the one the plan saw.
  const all = await listVars(a, cfg, false)
  const mine = all.filter((v) => belongs(v, file))
  if (w.expectedMtime > 0 && Math.max(0, ...mine.map((v) => v.updatedAt ?? 0)) !== w.expectedMtime)
    throw new Error(`${where} changed since this plan was made. Rescan, compare again, then apply.`)
  for (const e of w.entries) {
    const v = mine.find((x) => x.key === e.key)
    if (v?.type === 'system')
      throw new ProviderError(
        'config',
        `${e.key} is a Vercel system variable (${where}); Vercel sets it and it cannot be written. Untick it and apply again.`
      )
  }
  const create = async (body: Record<string, unknown>, key: string): Promise<void> => {
    const res = expectJson(
      await apiRequest(a, { method: 'POST', path: envPath, query: q, body }),
      `${where} variable ${key}`
    ) as { failed?: { error?: { message?: string } }[] } | null
    const failed = res?.failed?.[0]?.error?.message
    if (failed) throw new ProviderError('http', `${where} variable ${key}: ${failed.slice(0, 200)}`)
  }
  const patch = async (id: string, body: Record<string, unknown>, key: string): Promise<void> => {
    expectJson(
      await apiRequest(a, {
        method: 'PATCH',
        path: `/v9/projects/${encodeURIComponent(cfg.projectId)}/env/${encodeURIComponent(id)}`,
        query: q,
        body
      }),
      `${where} variable ${key}`
    )
  }
  const written = await applyEach(w.entries, async ({ key, value }) => {
    const v = mine.find((x) => x.key === key)
    const type = v && WRITABLE_TYPES.has(v.type) ? v.type : 'encrypted'
    if (!v) return create({ key, value, type, ...scope(file) }, key)
    const others = (v.target ?? []).filter((t) => t !== file.target)
    if (others.length === 0) return patch(v.id, { value, type, ...scope(file) }, key)
    // Shared across targets: detach this target, then give it its own copy with the new value.
    await patch(v.id, { target: others }, key)
    await create({ key, value, type, ...scope(file) }, key)
  })
  const back = (await listVars(a, cfg, true)).filter((v) => belongs(v, file))
  const sensitive = w.entries.filter((e) => back.find((v) => v.key === e.key)?.type === 'sensitive')
  const missing = w.entries
    .filter((e) => !sensitive.includes(e))
    .filter((e) => back.find((v) => v.key === e.key)?.value !== e.value)
    .map((e) => e.key)
  const effect = 'Vercel applies the new values to future deployments: redeploy to pick them up.'
  const base = verdict(w.entries, missing, effect)
  if (sensitive.length === 0) return { written, ...base }
  return {
    written,
    verified: false,
    note: `${sensitive.map((e) => e.key).join(', ')} ${sensitive.length === 1 ? 'is' : 'are'} sensitive in Vercel: present after the write, but the value can never be read back. ${missing.length ? base.note : `${effect}`}`
  }
}

async function backendScan(root: string, r: ProviderRef): Promise<ScanResult> {
  const store = requireStore()
  const started = performance.now()
  const { cfg, token } = cfgFor(store, r.connectionId)
  const vars = await listVars(api(cfg, token), cfg, false)
  const files: EnvFileInfo[] = []
  for (const [rel, modifiedAt] of fileSet(vars))
    files.push({
      path: providerRef('vercel', r.connectionId, posix.join(cfg.projectId, rel)),
      root,
      rel,
      name: posix.basename(rel),
      project: cfg.projectName,
      modifiedAt,
      size: 0
    })
  return finish(root, files, 1, started)
}

/** Call once at startup (src/main/providers/index.ts). */
export function registerVercel(store: Store): void {
  storeRef = store
  registerProviderBackend('vercel', {
    readEnv: backendReadEnv,
    readText: (r) => backendReadEnv(r).then((e) => e.text),
    stat: backendStat,
    scan: backendScan,
    apply: backendApply
  })
}

export async function connectVercel(
  store: Store,
  spec: Extract<ProviderConnectSpec, { provider: 'vercel' }>,
  baseUrl = VERCEL_API
): Promise<ProviderConnectResult> {
  const token = spec.token.trim()
  const teamId = spec.teamId?.trim() || null
  const a = api({ baseUrl }, token)
  const warnings: string[] = []
  const project = expectJson(
    await apiRequest(a, {
      method: 'GET',
      path: `/v9/projects/${encodeURIComponent(spec.project.trim())}`,
      query: { teamId: teamId ?? undefined }
    }).catch((e) => {
      throw e
    }),
    `Vercel project ${spec.project.trim()}`
  ) as { id?: string; name?: string }
  if (typeof project.id !== 'string' || typeof project.name !== 'string')
    throw new ProviderError('malformed', 'Vercel returned a project without id and name.')
  const cfg: Cfg = { baseUrl, teamId, projectId: project.id, projectName: project.name }
  const vars = await listVars(a, cfg, false)
  const files = fileSet(vars)
  const sensitive = vars.filter((v) => v.type === 'sensitive').length
  if (sensitive > 0)
    warnings.push(
      `${sensitive} sensitive variable${sensitive === 1 ? '' : 's'}: Vercel never returns their values, so they compare as "unknown".`
    )
  const label = spec.name.trim() || `vercel:${project.name}`
  const saved = saveConnection(store, 'vercel', label, cfg, token, spec.storage)
  if (saved.warning) warnings.push(saved.warning)
  return {
    root: { path: providerRef('vercel', saved.id, project.id), kind: 'vercel', label },
    summary: `${files.size} environment${files.size === 1 ? '' : 's'} · ${vars.length} variable${vars.length === 1 ? '' : 's'}`,
    warnings
  }
}
