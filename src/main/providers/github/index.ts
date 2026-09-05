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
import sodium from 'libsodium-wrappers'
import { applyEach } from '../writekit'
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

/**
 * GitHub Actions secrets and variables. A repository source has one file for
 * repository-level secrets + variables (`.env`) and one per deployment
 * environment (`.env.<environment>`); an organization source has one file.
 * GitHub never returns secret VALUES, only names: secrets render by name only and
 * compare as "unknown" (present / missing is all Drift can say). Variables do
 * come back with values and compare normally.
 *
 * API (docs.github.com/rest/actions, version 2022-11-28): Bearer token (fine-grained
 * PAT with Actions secrets/variables read, or classic `repo`/`admin:org`);
 * lists are paginated with per_page + page.
 * Writes: a key that exists as a secret is re-sealed with the scope's public key
 * (`GET …/secrets/public-key`, libsodium sealed box, `PUT …/secrets/{name}`
 * with encrypted_value + key_id); a key that exists as a variable is
 * `PATCH …/variables/{name}`; a key new to the scope becomes a SECRET (the safe
 * default, GitHub cannot turn it into a variable later without a delete).
 * Organization entries carry a visibility: existing ones keep theirs (fetched
 * first, selected repositories included); new organization entries are refused
 * because Drift cannot choose which repositories may see them. Secret values
 * can never be read back, so an apply that touched a secret reports presence,
 * not verification.
 */
export const GITHUB_API = 'https://api.github.com'
type Cfg = { baseUrl: string; owner: string; repo: string | null }
type Named = { name: string; value?: string; updated_at?: string }

let storeRef: Store | null = null
const requireStore = (): Store => {
  if (!storeRef) throw new Error('GitHub sources are only available inside the Drift app.')
  return storeRef
}
const api = (baseUrl: string, token: string): ApiConfig => ({
  baseUrl,
  headers: {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  }
})
const cfgFor = (store: Store, id: number): { cfg: Cfg; a: ApiConfig } => {
  const conn = connectionFor(store, id, 'github')
  const cfg = conn.config as Cfg
  return { cfg, a: api(cfg.baseUrl, secretFor(store, id, 'github')) }
}
const enc = encodeURIComponent

/** GET a paginated `{ total_count, <list>: [...] }` endpoint, every page. */
async function listAll(
  a: ApiConfig,
  path: string,
  list: string,
  context: string
): Promise<Named[]> {
  return paginate<Named, number>(1, async (page) => {
    const r = expectJson(
      await apiRequest(a, { method: 'GET', path, query: { per_page: '100', page: String(page) } }),
      context
    ) as Record<string, unknown>
    const items = r[list]
    if (!Array.isArray(items))
      throw new ProviderError('malformed', `${context}: no \`${list}\` list in the response.`)
    const total = Number(r['total_count'] ?? items.length)
    return {
      items: items as Named[],
      next: page * 100 < total && items.length > 0 ? page + 1 : null
    }
  })
}

/** The API prefix for a scope: repo, one repo environment, or the org. */
function scopePath(cfg: Cfg, environment: string | null): { path: string; label: string } {
  if (!cfg.repo)
    return { path: `/orgs/${enc(cfg.owner)}/actions`, label: `organization ${cfg.owner}` }
  const repo = `/repos/${enc(cfg.owner)}/${enc(cfg.repo)}`
  return environment
    ? {
        path: `${repo}/environments/${enc(environment)}`,
        label: `${cfg.owner}/${cfg.repo} environment ${environment}`
      }
    : { path: `${repo}/actions`, label: `repository ${cfg.owner}/${cfg.repo}` }
}

async function readScope(
  a: ApiConfig,
  cfg: Cfg,
  environment: string | null
): Promise<{ entries: Entry[]; updated: number }> {
  const s = scopePath(cfg, environment)
  const [secrets, variables] = await Promise.all([
    listAll(a, `${s.path}/secrets`, 'secrets', `GitHub ${s.label} secrets`),
    listAll(a, `${s.path}/variables`, 'variables', `GitHub ${s.label} variables`)
  ])
  const entries: Entry[] = [
    ...variables.map((v) => ({ key: v.name, value: typeof v.value === 'string' ? v.value : null })),
    ...secrets.map((v) => ({ key: v.name, value: null }))
  ]
  const updated = Math.max(
    0,
    ...[...secrets, ...variables].map((v) => Date.parse(v.updated_at ?? '') || 0)
  )
  return { entries, updated }
}

function fileOf(r: ProviderRef, cfg: Cfg): string | null {
  const rel = r.path
    .split('/')
    .slice(cfg.repo ? 2 : 1)
    .join('/')
  if (rel === '.env') return null
  const m = /^\.env\.(.+)$/.exec(rel)
  if (!m || !cfg.repo)
    throw new Error(`${rel}: unknown environment for ${cfg.owner}${cfg.repo ? '/' + cfg.repo : ''}`)
  return decodeURIComponent(m[1])
}

async function backendReadEnv(r: ProviderRef): Promise<EnvRead> {
  const { cfg, a } = cfgFor(requireStore(), r.connectionId)
  const environment = fileOf(r, cfg)
  const { entries } = await readScope(a, cfg, environment)
  return renderEnv(
    [
      `github:${scopePath(cfg, environment).label} · variables carry values, secrets are names only (GitHub never returns them)`
    ],
    entries
  )
}

async function backendStat(r: ProviderRef): Promise<Stat> {
  const { cfg, a } = cfgFor(requireStore(), r.connectionId)
  const { updated } = await readScope(a, cfg, fileOf(r, cfg))
  return { mtimeMs: updated, size: 0 }
}

async function environments(a: ApiConfig, cfg: Cfg): Promise<string[]> {
  if (!cfg.repo) return []
  const items = await listAll(
    a,
    `/repos/${enc(cfg.owner)}/${enc(cfg.repo)}/environments`,
    'environments',
    `GitHub ${cfg.owner}/${cfg.repo} environments`
  )
  return items.map((e) => e.name)
}

async function backendScan(root: string, r: ProviderRef): Promise<ScanResult> {
  const started = performance.now()
  const { cfg, a } = cfgFor(requireStore(), r.connectionId)
  const scope = cfg.repo ? `${cfg.owner}/${cfg.repo}` : cfg.owner
  const file = (rel: string): EnvFileInfo => ({
    path: providerRef('github', r.connectionId, `${scope}/${rel}`),
    root,
    rel,
    name: rel,
    project: scope,
    modifiedAt: 0,
    size: 0
  })
  // Metadata only: no secret or variable listing during a scan.
  const files = [file('.env'), ...(await environments(a, cfg)).map((e) => file(`.env.${enc(e)}`))]
  return finish(root, files, 1, started)
}

async function sealFor(
  a: ApiConfig,
  s: { path: string; label: string },
  value: string
): Promise<{ key_id: string; encrypted_value: string }> {
  const pk = expectJson(
    await apiRequest(a, { method: 'GET', path: `${s.path}/secrets/public-key` }),
    `GitHub ${s.label} public key`
  ) as { key_id?: string; key?: string }
  if (typeof pk.key_id !== 'string' || typeof pk.key !== 'string')
    throw new ProviderError('malformed', `GitHub ${s.label}: no public key in the response.`)
  await sodium.ready
  const box = sodium.crypto_box_seal(
    sodium.from_string(value),
    sodium.from_base64(pk.key, sodium.base64_variants.ORIGINAL)
  )
  return {
    key_id: pk.key_id,
    encrypted_value: sodium.to_base64(box, sodium.base64_variants.ORIGINAL)
  }
}

/** Organization secrets must restate their visibility on every PUT; read it (and the repo list) first. */
async function orgVisibility(
  a: ApiConfig,
  cfg: Cfg,
  name: string
): Promise<{ visibility: string; selected_repository_ids?: number[] }> {
  const path = `/orgs/${enc(cfg.owner)}/actions/secrets/${enc(name)}`
  const s = expectJson(
    await apiRequest(a, { method: 'GET', path }),
    `GitHub organization ${cfg.owner} secret ${name}`
  ) as { visibility?: string }
  if (s.visibility !== 'all' && s.visibility !== 'private' && s.visibility !== 'selected')
    throw new ProviderError(
      'malformed',
      `GitHub organization secret ${name}: no visibility in the response.`
    )
  if (s.visibility !== 'selected') return { visibility: s.visibility }
  const repos = await listAll(
    a,
    `${path}/repositories`,
    'repositories',
    `GitHub organization ${cfg.owner} secret ${name} repositories`
  )
  return {
    visibility: 'selected',
    selected_repository_ids: (repos as unknown as { id: number }[]).map((r) => r.id)
  }
}

async function backendApply(r: ProviderRef, w: ProviderWrite): Promise<ProviderWriteResult> {
  const { cfg, a } = cfgFor(requireStore(), r.connectionId)
  const environment = fileOf(r, cfg)
  const s = scopePath(cfg, environment)
  // Re-read right before mutating: which keys are secrets, which are variables.
  const { entries: current } = await readScope(a, cfg, environment)
  const kinds = new Map(
    current.map((e) => [e.key, e.value === null ? 'secret' : 'variable'] as const)
  )
  if (!cfg.repo) {
    const fresh = w.entries.filter((e) => !kinds.has(e.key)).map((e) => e.key)
    if (fresh.length)
      throw new ProviderError(
        'config',
        `${fresh.join(', ')} ${fresh.length === 1 ? 'does' : 'do'} not exist in organization ${cfg.owner} yet, and Drift cannot choose which repositories may see a new organization entry. Create it in GitHub with the right visibility, then apply again to set its value.`
      )
  }
  const secrets: string[] = []
  const variables: string[] = []
  const written = await applyEach(w.entries, async ({ key, value }) => {
    const kind = kinds.get(key) ?? 'secret'
    if (kind === 'secret') {
      secrets.push(key)
      const body: Record<string, unknown> = await sealFor(a, s, value)
      if (!cfg.repo) Object.assign(body, await orgVisibility(a, cfg, key))
      expectJson(
        await apiRequest(a, { method: 'PUT', path: `${s.path}/secrets/${enc(key)}`, body }),
        `GitHub ${s.label} secret ${key}`
      )
      return
    }
    variables.push(key)
    expectJson(
      await apiRequest(a, {
        method: 'PATCH',
        path: `${s.path}/variables/${enc(key)}`,
        body: { name: key, value }
      }),
      `GitHub ${s.label} variable ${key}`
    )
  })
  // Read back: variables by value, secrets by presence only (GitHub never returns them).
  const back = await readScope(a, cfg, environment)
  const byKey = new Map(back.entries.map((e) => [e.key, e.value]))
  const missingVars = variables.filter(
    (k) => byKey.get(k) !== w.entries.find((e) => e.key === k)?.value
  )
  const missingSecrets = secrets.filter((k) => byKey.get(k) !== null)
  const missing = [...missingVars, ...missingSecrets]
  const effect = 'Workflows pick the new values up on their next run.'
  if (missing.length)
    return {
      written,
      verified: false,
      note: `Read-back did not confirm ${missing.join(', ')}: GitHub accepted the write but the scope now reports something else. Check it in GitHub before relying on it. ${effect}`
    }
  if (secrets.length === 0)
    return {
      written,
      verified: true,
      note: `${variables.length} variable${variables.length === 1 ? '' : 's'} confirmed by read-back. ${effect}`
    }
  return {
    written,
    verified: false,
    note: `${secrets.join(', ')} ${secrets.length === 1 ? 'is a secret' : 'are secrets'}: GitHub confirms ${secrets.length === 1 ? 'it is' : 'they are'} present but never returns the value, so it cannot be verified by read-back.${variables.length ? ` ${variables.join(', ')} confirmed by read-back.` : ''} ${effect}`
  }
}

export function registerGithub(store: Store): void {
  storeRef = store
  registerProviderBackend('github', {
    readEnv: backendReadEnv,
    readText: (r) => backendReadEnv(r).then((e) => e.text),
    stat: backendStat,
    scan: backendScan,
    apply: backendApply
  })
}

export async function connectGithub(
  store: Store,
  spec: Extract<ProviderConnectSpec, { provider: 'github' }>,
  baseUrl = GITHUB_API
): Promise<ProviderConnectResult> {
  const token = spec.token.trim()
  const cfg: Cfg = { baseUrl, owner: spec.owner.trim(), repo: spec.repo?.trim() || null }
  const a = api(baseUrl, token)
  const scope = cfg.repo ? `${cfg.owner}/${cfg.repo}` : cfg.owner
  // Preflight: the repo or org must be visible to the token.
  expectJson(
    await apiRequest(a, {
      method: 'GET',
      path: cfg.repo ? `/repos/${enc(cfg.owner)}/${enc(cfg.repo)}` : `/orgs/${enc(cfg.owner)}`
    }),
    `GitHub ${cfg.repo ? 'repository' : 'organization'} ${scope}`
  )
  const { entries } = await readScope(a, cfg, null)
  const envs = await environments(a, cfg)
  const secrets = entries.filter((e) => e.value === null).length
  const warnings = [
    `GitHub never returns secret values: ${secrets} secret${secrets === 1 ? '' : 's'} compare as "unknown" (present or missing only).`
  ]
  const label = spec.name.trim() || `github:${scope}`
  const saved = saveConnection(store, 'github', label, cfg, token, spec.storage)
  if (saved.warning) warnings.push(saved.warning)
  return {
    root: { path: providerRef('github', saved.id, scope), kind: 'github', label },
    summary: `${entries.length - secrets} variable${entries.length - secrets === 1 ? '' : 's'} · ${secrets} secret${secrets === 1 ? '' : 's'} (names only)${envs.length ? ` · ${envs.length} environment${envs.length === 1 ? '' : 's'}` : ''}`,
    warnings
  }
}
