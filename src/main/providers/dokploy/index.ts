import {
  finish,
  providerRef,
  registerProviderBackend,
  type ProviderRef,
  type ProviderWrite,
  type ProviderWriteResult,
  type Stat
} from '../../fs'
import { parseEnv, patchEnv } from '@shared/env-file'
import { renderAssignment } from '@shared/env-lint'
import { unconfirmed, verdict } from '../writekit'
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
 * Dokploy application variables. Self-hosted: instance URL + API key, optional
 * custom CA. Dokploy stores an application's environment as `.env`-formatted
 * text, which becomes the file body verbatim (with a header).
 * Files: `<project>/<application>/.env`, or `<project>/<environment>/<application>/.env`
 * on Dokploy versions with environments.
 *
 * API (docs.dokploy.com/docs/api, checked 2026-09): header `x-api-key`;
 * GET /api/project.all; GET /api/application.one?applicationId=…;
 * POST /api/application.saveEnvironment { applicationId, env, buildArgs,
 * buildSecrets, createEnvFile } replaces the whole env text, so a write
 * re-reads it, patches the approved keys in place (comments and order kept)
 * and saves it back with the other fields carried through unchanged. Dokploy
 * has no version to compare-and-set on; the re-read happens right before the
 * save.
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

type AppOne = {
  env?: string | null
  buildArgs?: string | null
  buildSecrets?: string | null
  createEnvFile?: boolean
  name?: string
  appName?: string
}
const appId = (r: ProviderRef): string => {
  const m = /^([^/]+)\/\.env$/.exec(r.path)
  if (!m) throw new Error(`${r.path}: not a Dokploy application file`)
  return m[1]
}
async function readApp(a: ApiConfig, id: string): Promise<AppOne> {
  return expectJson(
    await apiRequest(a, {
      method: 'GET',
      path: '/api/application.one',
      query: { applicationId: id }
    }),
    `Dokploy application ${id}`
  ) as AppOne
}
const envText = (app: AppOne): string => {
  const env = typeof app.env === 'string' ? app.env : ''
  return env === '' || env.endsWith('\n') ? env : env + '\n'
}

async function backendReadText(r: ProviderRef): Promise<string> {
  const { cfg, a } = cfgFor(requireStore(), r.connectionId)
  const id = appId(r)
  const app = await readApp(a, id)
  return `# dokploy:${new URL(cfg.address).host} ${app.name || app.appName || id} · values live in Dokploy\n${envText(app)}`
}

async function backendApply(r: ProviderRef, w: ProviderWrite): Promise<ProviderWriteResult> {
  const { a } = cfgFor(requireStore(), r.connectionId)
  const id = appId(r)
  const app = await readApp(a, id) // re-read right before the save
  const before = envText(app)
  const next = patchEnv(
    before,
    w.entries.map((e) => ({ key: e.key, text: renderAssignment(before, e.key, e.value) }))
  )
  expectJson(
    await apiRequest(a, {
      method: 'POST',
      path: '/api/application.saveEnvironment',
      body: {
        applicationId: id,
        env: next,
        buildArgs: app.buildArgs ?? null,
        buildSecrets: app.buildSecrets ?? null,
        createEnvFile: app.createEnvFile ?? false
      }
    }),
    `Dokploy application ${id} environment`
  )
  const back = new Map(parseEnv(envText(await readApp(a, id))).map((e) => [e.key, e.value]))
  const missing = unconfirmed(w.entries, (k) => back.get(k))
  return {
    written: w.entries.map((e) => e.key),
    ...verdict(
      w.entries,
      missing,
      'Dokploy uses the new environment on the next deployment: redeploy the application to pick it up.'
    )
  }
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
    scan: backendScan,
    apply: backendApply
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
    summary: `${list.length} project${list.length === 1 ? '' : 's'} · ${all.length} application${all.length === 1 ? '' : 's'}`,
    warnings: saved.warning ? [saved.warning] : []
  }
}
