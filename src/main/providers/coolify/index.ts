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
import { apiRequest, expectJson, ProviderError, type ApiConfig } from '../http'
import { connectionFor, saveConnection, secretFor } from '../connection'
import { renderEnv } from '../envtext'
import { assertAddress } from '../vault/client'
import { applyEach, unconfirmed, verdict } from '../writekit'

/**
 * Coolify application variables. Self-hosted: instance URL + API token,
 * optional custom CA. Each application gives `<name>/.env` and, when it has
 * preview-deployment variables, `<name>/.env.preview`. Values come back from
 * the API; a variable the API returns without a value is names-only.
 *
 * API (coolify.io/docs/api-reference and the project's openapi.yaml, checked
 * 2026-09): Bearer token under /api/v1; GET /applications; GET
 * /applications/{uuid}/envs. Writes: PATCH /applications/{uuid}/envs updates
 * one variable by key (+ is_preview), POST creates one; both carry
 * is_literal / is_multiline / is_shown_once. Coolify applies the new values
 * on the next deployment.
 */
type Cfg = { address: string; caPem: string | null }
type App = { uuid: string; name?: string; updated_at?: string }
type Env = {
  key: string
  value?: string | null
  is_preview?: boolean
  is_literal?: boolean
  is_multiline?: boolean
  is_shown_once?: boolean
  updated_at?: string
}

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

const newest = (list: Env[]): number =>
  Math.max(0, ...list.map((e) => Date.parse(e.updated_at ?? '') || 0))

async function backendStat(r: ProviderRef): Promise<Stat> {
  const { a } = cfgFor(requireStore(), r.connectionId)
  const f = parseFile(r)
  const list = (await envs(a, f.uuid)).filter((e) => Boolean(e.is_preview) === f.preview)
  return { mtimeMs: newest(list), size: 0 }
}

async function backendApply(r: ProviderRef, w: ProviderWrite): Promise<ProviderWriteResult> {
  const { a } = cfgFor(requireStore(), r.connectionId)
  const f = parseFile(r)
  const what = `Coolify application ${f.uuid}${f.preview ? ' (preview)' : ''}`
  // Re-read right before mutating: the timestamps must still be the ones the plan saw.
  const current = (await envs(a, f.uuid)).filter((e) => Boolean(e.is_preview) === f.preview)
  if (w.expectedMtime > 0 && newest(current) !== w.expectedMtime)
    throw new Error(`${what} changed since this plan was made. Rescan, compare again, then apply.`)
  const byKey = new Map(current.map((e) => [e.key, e]))
  const written = await applyEach(w.entries, async ({ key, value }) => {
    const existing = byKey.get(key)
    const body = existing
      ? {
          key,
          value,
          is_preview: f.preview,
          ...(existing.is_literal !== undefined ? { is_literal: existing.is_literal } : {}),
          ...(existing.is_multiline !== undefined ? { is_multiline: existing.is_multiline } : {}),
          ...(existing.is_shown_once !== undefined ? { is_shown_once: existing.is_shown_once } : {})
        }
      : { key, value, is_preview: f.preview }
    expectJson(
      await apiRequest(a, {
        method: existing ? 'PATCH' : 'POST',
        path: `/applications/${encodeURIComponent(f.uuid)}/envs`,
        body
      }),
      `${what} variable ${key}`
    )
  })
  const back = (await envs(a, f.uuid)).filter((e) => Boolean(e.is_preview) === f.preview)
  const values = new Map(back.map((e) => [e.key, typeof e.value === 'string' ? e.value : null]))
  const missing = unconfirmed(w.entries, (k) => values.get(k))
  return {
    written,
    ...verdict(
      w.entries,
      missing,
      'Coolify uses the new values on the next deployment: redeploy the application to pick them up.'
    )
  }
}

async function backendScan(root: string, r: ProviderRef): Promise<ScanResult> {
  const started = performance.now()
  const { a } = cfgFor(requireStore(), r.connectionId)
  const files: EnvFileInfo[] = []
  for (const app of await applications(a)) {
    const name = app.name || app.uuid
    // ponytail: one envs call per application to learn whether a preview file exists; batch or lazy if an instance has 100+ apps.
    const list = await envs(a, app.uuid)
    // Same timestamp as stat (newest variable of that file), so the write guard compares like with like.
    const file = (suffix: string, preview: boolean): EnvFileInfo => ({
      path: providerRef('coolify', r.connectionId, `${app.uuid}/.env${suffix}`),
      root,
      rel: `${name}/.env${suffix}`,
      name: `.env${suffix}`,
      project: name,
      modifiedAt: newest(list.filter((e) => Boolean(e.is_preview) === preview)),
      size: 0
    })
    files.push(file('', false))
    if (list.some((e) => e.is_preview)) files.push(file('.preview', true))
  }
  return finish(root, files, 1, started)
}

export function registerCoolify(store: Store): void {
  storeRef = store
  registerProviderBackend('coolify', {
    readEnv: backendReadEnv,
    readText: (r) => backendReadEnv(r).then((e) => e.text),
    stat: backendStat,
    scan: backendScan,
    apply: backendApply
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
    summary: `${list.length} application${list.length === 1 ? '' : 's'}`,
    warnings: saved.warning ? [saved.warning] : []
  }
}
