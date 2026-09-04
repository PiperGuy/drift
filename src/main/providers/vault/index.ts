import { safeStorage, app } from 'electron'
import { posix } from 'node:path'
import {
  registerVaultBackend,
  vaultRef,
  parseRef,
  readEnv,
  type VaultRef,
  type Stat
} from '../../fs'
import { fingerprint } from '../../env'
import type { Store } from '../../store'
import { parseEnv } from '@shared/env-file'
import { quoteIfNeeded } from '@shared/env-lint'
import type {
  ApplyRequest,
  ApplyResult,
  EnvFileInfo,
  EnvShape,
  RootInfo,
  ScanResult,
  VaultConnectResult,
  VaultHistory,
  VaultPreflight,
  VaultSourceSpec
} from '@shared/channels'
import {
  approleLogin,
  capabilities,
  health,
  isWrappingToken,
  list,
  lookupSelf,
  mountFor,
  readData,
  readMetadata,
  unwrap,
  writeData,
  type VaultConfig
} from './client'

/**
 * HashiCorp Vault KV v2 adapter. One KV v2 secret document = one environment
 * "file"; a folder of documents = a source whose leaves are the environments.
 * Reads render the document as canonical `KEY=value` text so the existing
 * redaction, viewer, receipt and reveal paths work unchanged. Writes never go
 * through the file path: they are full-document POSTs guarded by Vault's
 * check-and-set (`options.cas` = the version the plan was built from), so a
 * concurrent writer can never be overwritten silently.
 *
 * Credentials: session-only by default, held in a main-process Map. With the
 * user's opt-in the resolved client token (never an AppRole secret_id) is
 * sealed by the OS keyring via safeStorage into connections.secret_blob.
 */

/** Session tokens per connection id. Never serialised, never logged. */
const tokens = new Map<number, string>()

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_.-]*$/
const ua = (): string =>
  `Drift/${typeof app?.getVersion === 'function' ? app.getVersion() : '0.0.0'}`

const NEEDS_REAUTH =
  'This Vault source needs sign-in again: open Update source and re-enter your credentials.'

function cfgFor(store: Store, connectionId: number): VaultConfig {
  const conn = store.getConnection(connectionId)
  if (!conn || conn.provider !== 'vault')
    throw new Error('This Vault connection no longer exists. Remove the source and add it again.')
  let token = tokens.get(connectionId)
  if (!token && conn.secretBlob && safeStorage.isEncryptionAvailable()) {
    try {
      token = (JSON.parse(safeStorage.decryptString(conn.secretBlob)) as { token?: string }).token
      if (token) tokens.set(connectionId, token)
    } catch {
      // Keyring changed or blob copied from another machine: fall through to re-auth.
    }
  }
  if (!token) throw new Error(NEEDS_REAUTH)
  store.touchConnection(connectionId)
  const c = conn.config as {
    address: string
    namespace?: string
    caPem?: string
    serverName?: string
  }
  return {
    address: c.address,
    namespace: c.namespace || undefined,
    caPem: c.caPem || undefined,
    serverName: c.serverName || undefined,
    token,
    userAgent: ua()
  }
}

const mountAndPath = (
  store: Store,
  r: VaultRef
): { cfg: VaultConfig; mount: string; path: string } => ({
  cfg: cfgFor(store, r.connectionId),
  mount: r.mount,
  path: r.path
})

// ---------- rendering ----------

/**
 * Canonical `.env` text for a KV v2 document. Only string values with valid env
 * key names are rendered; everything else stays in the document and is carried
 * through verbatim on writes. Matches formatEnv's canonical form, so the viewer
 * shows the file as "Formatted" and the Format button stays disabled.
 */
export function renderEnvText(
  mount: string,
  path: string,
  version: number,
  data: Record<string, unknown>
): string {
  const lines: string[] = [`# vault:${mount}/${path} @ v${version} · values live in Vault`]
  let hidden = 0
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === 'string' && ENV_KEY.test(key)) lines.push(`${key}=${quoteIfNeeded(value)}`)
    else hidden += 1
  }
  if (hidden > 0)
    lines.push(
      `# ${hidden} key${hidden === 1 ? '' : 's'} not shown (non-string value or unusual name) · kept unchanged on writes`
    )
  return lines.join('\n') + '\n'
}

const deletedMessage = (r: VaultRef, kind: 'deleted' | 'destroyed', version: number): string =>
  kind === 'deleted'
    ? `The current version (v${version}) of ${r.mount}/${r.path} is soft-deleted in Vault. Restore an earlier version from its history.`
    : `The current version (v${version}) of ${r.mount}/${r.path} is destroyed in Vault. Restore from another live version.`

async function currentDoc(
  store: Store,
  r: VaultRef
): Promise<{ version: number; data: Record<string, unknown> }> {
  const { cfg, mount, path } = mountAndPath(store, r)
  const res = await readData(cfg, mount, path)
  if (res.kind === 'absent')
    throw new Error(`${mount}/${path}: not found in Vault (or no permission).`)
  if (res.kind !== 'ok') throw new Error(deletedMessage(r, res.kind, res.meta.version))
  return { version: res.version, data: res.data }
}

// ---------- backend for src/main/fs.ts ----------

async function backendReadText(r: VaultRef): Promise<string> {
  const store = requireStore()
  const { version, data } = await currentDoc(store, r)
  return renderEnvText(r.mount, r.path, version, data)
}

async function backendStat(r: VaultRef): Promise<Stat> {
  const store = requireStore()
  const { cfg, mount, path } = mountAndPath(store, r)
  const meta = await readMetadata(cfg, mount, path)
  if (!meta) throw new Error(`${mount}/${path}: not found`)
  return { mtimeMs: Date.parse(meta.updatedTime || meta.createdTime) || 0, size: 0 }
}

const LEAF_CAP = 200

async function backendScan(root: string, r: VaultRef): Promise<ScanResult> {
  const store = requireStore()
  const started = performance.now()
  const { cfg, mount, path } = mountAndPath(store, r)
  const files: EnvFileInfo[] = []

  const fileInfo = async (leafPath: string): Promise<EnvFileInfo | null> => {
    const meta = await readMetadata(cfg, mount, leafPath)
    if (!meta) return null
    return {
      path: vaultRef(r.connectionId, mount, leafPath),
      root,
      rel: leafPath === path ? posix.basename(leafPath) : posix.relative(path, leafPath),
      name: posix.basename(leafPath),
      project: `${mount}/${leafPath === path ? posix.dirname(leafPath) : path}`.replace(
        /\/\.$/,
        ''
      ),
      modifiedAt: Date.parse(meta.updatedTime || meta.createdTime) || 0,
      size: 0,
      version: meta.currentVersion
    }
  }

  const own = await fileInfo(path)
  if (own) files.push(own)
  else {
    const l = await list(cfg, mount, path)
    if (!('empty' in l)) {
      // Non-recursive on purpose: sub-folders are skipped, leaves become environments.
      const leaves = l.keys.filter((k) => !k.endsWith('/')).slice(0, LEAF_CAP)
      const infos = await Promise.all(leaves.map((leaf) => fileInfo(posix.join(path, leaf))))
      for (const f of infos) if (f) files.push(f)
    }
  }
  files.sort((a, b) => a.rel.localeCompare(b.rel))
  const projects = [...new Set(files.map((f) => f.project).filter((p): p is string => p !== null))]
  return {
    root,
    files,
    projects,
    scannedDirs: 1,
    durationMs: Math.round(performance.now() - started)
  }
}

/** The store the adapter reads connections from; set once by registerVault(). */
let storeRef: Store | null = null
const requireStore = (): Store => {
  if (!storeRef) throw new Error('Vault sources are only available inside the Drift app.')
  return storeRef
}

/** Call once at startup (src/main/ipc.ts). The MCP process never calls this. */
export function registerVault(store: Store): void {
  storeRef = store
  registerVaultBackend({ readText: backendReadText, stat: backendStat, scan: backendScan })
}

// ---------- connect ----------

const stripSlashes = (s: string): string => s.replace(/^\/+|\/+$/g, '')

export async function connectVault(
  store: Store,
  spec: VaultSourceSpec
): Promise<VaultConnectResult> {
  const warnings: string[] = []
  const base: VaultConfig = {
    address: spec.address.trim(),
    namespace: spec.namespace?.trim() || undefined,
    caPem: spec.caPem?.trim() || undefined,
    serverName: undefined,
    userAgent: ua()
  }

  // 1. Reachability, TLS and seal state — unauthenticated, root namespace.
  const h = await health(base)
  if (h.status === 501) throw new Error('This Vault is not initialised.')
  if (h.status === 503)
    throw new Error('This Vault is sealed. Ask an operator to unseal it, then retry.')
  if (h.status === 429 || h.status === 472 || h.status === 473 || h.status === 474)
    warnings.push(
      'A standby node answered the health check. If requests fail, use the active or load-balancer address.'
    )
  else if (h.status !== 200) throw new Error(`Vault health check failed (HTTP ${h.status}).`)

  // 2. Credentials → client token. AppRole secret_id is used once and discarded.
  let token: string
  if (spec.auth.kind === 'approle') {
    token = (await approleLogin(base, spec.auth.roleId, spec.auth.secretId)).token
  } else {
    token = spec.auth.token.trim()
    if (await isWrappingToken(base, token)) token = await unwrap(base, token)
  }
  const cfg: VaultConfig = { ...base, token }

  // 3. Who am I — catches bad token and (on HCP) a wrong or missing namespace.
  const info = await lookupSelf(cfg).catch((e) => {
    throw new Error(
      `${e instanceof Error ? e.message : e}${base.namespace ? '' : ' — on HCP Vault Dedicated, set the namespace (usually "admin").'}`
    )
  })
  if (info.policies.includes('root'))
    warnings.push('This is a ROOT token. Use a scoped token instead wherever possible.')
  if (info.type === 'batch') warnings.push('Batch token: it cannot be renewed and may expire soon.')
  if (info.expireTime && Date.parse(info.expireTime) - Date.now() < 10 * 60_000)
    warnings.push('This token expires in under 10 minutes.')
  if (info.numUses > 0) warnings.push(`This token has only ${info.numUses} uses left.`)

  // 4. Mount resolution and KV version check.
  const full = stripSlashes(spec.path)
  const m = await mountFor(cfg, full)
  if (m.kvVersion !== '2')
    throw new Error(
      m.kvVersion === '1'
        ? `${m.mount} is a KV version 1 mount. Drift supports KV v2 only (versioned secrets).`
        : `${full}: could not confirm a KV v2 mount (check the path and your policy).`
    )
  if (full === m.mount || !full.startsWith(`${m.mount}/`))
    throw new Error(`Give a path inside the mount, e.g. ${m.mount}/apps/api/prod`)
  const rel = full.slice(m.mount.length + 1)

  // 5. Leaf or folder?
  const meta = await readMetadata(cfg, m.mount, rel)
  let kind: 'leaf' | 'folder'
  if (meta) kind = 'leaf'
  else {
    const l = await list(cfg, m.mount, rel)
    if ('empty' in l || l.keys.filter((k) => !k.endsWith('/')).length === 0)
      throw new Error(
        `${full}: nothing readable here — no secret document and no folder of secrets (or the token lacks permission).`
      )
    kind = 'folder'
  }

  // 6. Capabilities — drive the UI, warn early instead of failing at apply time.
  const capPaths =
    kind === 'leaf'
      ? [`${m.mount}/data/${rel}`, `${m.mount}/metadata/${rel}`]
      : [`${m.mount}/metadata/${rel}/`, `${m.mount}/data/${rel}/*`]
  const caps = await capabilities(cfg, capPaths).catch(() => ({}) as Record<string, string[]>)
  const dataCaps = caps[capPaths[0]] ?? []
  if (kind === 'leaf' && !dataCaps.includes('read') && !dataCaps.includes('root'))
    warnings.push(`The token has no read capability on ${capPaths[0]}; reads will fail.`)
  if (
    kind === 'leaf' &&
    !dataCaps.includes('create') &&
    !dataCaps.includes('update') &&
    !dataCaps.includes('root')
  )
    warnings.push('Read-only: the token cannot write this path, so Apply will be refused by Vault.')

  // 7. Persist. config_json never contains a credential.
  const storage: 'session' | 'keychain' =
    spec.storage === 'keychain' && safeStorage.isEncryptionAvailable() ? 'keychain' : 'session'
  if (spec.storage === 'keychain' && storage === 'session')
    warnings.push('No OS keyring is available; the token is kept for this session only.')
  const label = spec.name.trim() || `vault:${m.mount}/${rel}`
  const id = store.addConnection(
    'vault',
    label,
    {
      address: base.address,
      namespace: base.namespace ?? null,
      caPem: base.caPem ?? null,
      mount: m.mount,
      path: rel,
      authKind: spec.auth.kind,
      storage
    },
    storage === 'keychain' ? safeStorage.encryptString(JSON.stringify({ token })) : null
  )
  tokens.set(id, token)

  const rootPath = vaultRef(id, m.mount, rel)
  const root: RootInfo = { path: rootPath, kind: 'vault', label }
  const preflight: VaultPreflight = {
    vaultVersion: h.body?.version ?? 'unknown',
    enterprise: Boolean(h.body?.enterprise),
    mount: m.mount,
    kind,
    casRequired: m.config?.casRequired ?? false,
    maxVersions: m.config?.maxVersions ?? 0,
    deleteVersionAfter: m.config?.deleteVersionAfter ?? '0s',
    token: {
      accessor: info.accessor,
      displayName: info.displayName,
      policies: info.policies,
      expireTime: info.expireTime,
      renewable: info.renewable,
      type: info.type
    },
    capabilities: caps,
    warnings
  }
  return { root, preflight }
}

/** Forget in-memory session tokens for removed connections (bulk forget/delete paths). */
export function dropVaultTokens(connectionIds: number[]): void {
  for (const id of connectionIds) tokens.delete(id)
}

export function forgetVaultConnection(store: Store, ref: string): void {
  const r = parseRef(ref)
  if (r.kind !== 'vault') return
  tokens.delete(r.connectionId)
  store.deleteConnection(r.connectionId)
}

// ---------- history / versions ----------

export async function vaultHistory(store: Store, refStr: string): Promise<VaultHistory> {
  const r = parseRef(refStr)
  if (r.kind !== 'vault') throw new Error('Not a Vault path')
  const { cfg, mount, path } = mountAndPath(store, r)
  const meta = await readMetadata(cfg, mount, path)
  if (!meta)
    throw new Error(`${mount}/${path}: no metadata (deleted, or the token lacks metadata read).`)
  return {
    path: refStr,
    currentVersion: meta.currentVersion,
    oldestVersion: meta.oldestVersion,
    maxVersions: meta.maxVersions,
    casRequired: meta.casRequired,
    deleteVersionAfter: meta.deleteVersionAfter,
    updatedTime: meta.updatedTime,
    versions: meta.versions
  }
}

/** Redacted shape of one historical version, fetched on demand — never prefetched. */
export async function vaultShapeAt(
  store: Store,
  refStr: string,
  version: number
): Promise<EnvShape> {
  const r = parseRef(refStr)
  if (r.kind !== 'vault') throw new Error('Not a Vault path')
  const { cfg, mount, path } = mountAndPath(store, r)
  const res = await readData(cfg, mount, path, version)
  if (res.kind === 'absent') throw new Error(`${mount}/${path}: v${version} does not exist.`)
  if (res.kind !== 'ok')
    throw new Error(
      res.kind === 'deleted'
        ? `v${version} is soft-deleted; its data cannot be read.`
        : `v${version} is destroyed; its data is gone permanently.`
    )
  const entries = Object.entries(res.data)
    .filter((e): e is [string, string] => typeof e[1] === 'string' && ENV_KEY.test(e[0]))
    .map(([key, value]) => ({ key, fingerprint: value === '' ? null : fingerprint(value) }))
  return { path: `${refStr}@v${version}`, name: `${posix.basename(path)}@v${version}`, entries }
}

// ---------- writes (only reachable from the approval dialog / History) ----------

const canon = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`
  if (v !== null && typeof v === 'object')
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`)
      .join(',')}}`
  return JSON.stringify(v)
}

const CHANGED = (right: string): string =>
  `${right} changed since this plan was made. Compare again, then apply.`

/**
 * Apply an approved plan to a Vault target: full document, `cas` = the version
 * the plan was built from. Nothing is retried; a concurrent write surfaces as
 * "changed since this plan was made".
 */
export async function applyVault(store: Store, req: ApplyRequest): Promise<ApplyResult> {
  const r = parseRef(req.right)
  if (r.kind !== 'vault') throw new Error('Not a Vault path')
  if (typeof req.expectedVersion !== 'number' || req.expectedVersion < 1)
    throw new Error(
      `${req.right} has no Vault version attached. Rescan, compare again, then apply.`
    )
  const { cfg, mount, path } = mountAndPath(store, r)

  // R1/R2 — the plan's base must still be the live version.
  const cur = await readData(cfg, mount, path)
  if (cur.kind === 'absent') throw new Error(`${mount}/${path}: no longer exists in Vault.`)
  if (cur.kind !== 'ok') throw new Error(deletedMessage(r, cur.kind, cur.meta.version))
  if (cur.version !== req.expectedVersion) throw new Error(CHANGED(req.right))

  const { text: leftText, opaque } = await readEnv(req.left)
  const leftValues = new Map(parseEnv(leftText).map((e) => [e.key, e.value]))
  const written: string[] = []
  const skipped: ApplyResult['skipped'] = []
  const doc: Record<string, unknown> = { ...cur.data } // carries every untouched key verbatim
  for (const key of req.keys) {
    const value = leftValues.get(key)
    if (value === undefined) skipped.push({ key, reason: 'not in source' })
    else if (value === '') skipped.push({ key, reason: 'blank in source' })
    else if (opaque.has(key)) skipped.push({ key, reason: 'value not readable from source' })
    else {
      doc[key] = value
      written.push(key)
    }
  }
  if (written.length === 0) throw new Error('Nothing to write: every key was skipped.')

  // Shape-only local record (no blob): Vault's own versions are the rollback path.
  const snapshot = store.saveSnapshot({
    path: req.right,
    at: Date.now(),
    reason: 'apply',
    mtime: cur.version,
    size: 0,
    keys: Object.keys(cur.data).filter((k) => ENV_KEY.test(k)),
    blob: null
  })

  const wr = await writeData(cfg, mount, path, doc, cur.version, `drift-apply-${snapshot}`)
  if (wr.kind === 'cas-mismatch') throw new Error(CHANGED(req.right))
  if (wr.kind === 'error')
    throw new Error(
      `Vault refused the write (HTTP ${wr.status}): ${wr.errors.join('; ') || 'unknown error'}`
    )

  // R8 — read back the new version and verify it is exactly what was approved.
  const back = await readData(cfg, mount, path, wr.meta.version)
  const verified = back.kind === 'ok' && canon(back.data) === canon(doc)
  return {
    written,
    skipped,
    snapshot,
    version: { base: cur.version, next: wr.meta.version },
    verified
  }
}

/** Restore vN by writing its data as a new version, CAS-guarded on the current one. */
export async function vaultRestore(
  store: Store,
  refStr: string,
  version: number,
  expectedVersion: number
): Promise<ApplyResult> {
  const r = parseRef(refStr)
  if (r.kind !== 'vault') throw new Error('Not a Vault path')
  const { cfg, mount, path } = mountAndPath(store, r)
  const src = await readData(cfg, mount, path, version)
  if (src.kind === 'absent') throw new Error(`v${version} does not exist.`)
  if (src.kind !== 'ok')
    throw new Error(
      src.kind === 'deleted'
        ? `v${version} is soft-deleted and cannot be restored from here.`
        : `v${version} is destroyed; its data is gone permanently.`
    )
  const snapshot = store.saveSnapshot({
    path: refStr,
    at: Date.now(),
    reason: 'rollback',
    mtime: expectedVersion,
    size: 0,
    keys: Object.keys(src.data).filter((k) => ENV_KEY.test(k)),
    blob: null
  })
  const wr = await writeData(
    cfg,
    mount,
    path,
    src.data,
    expectedVersion,
    `drift-restore-${snapshot}`
  )
  if (wr.kind === 'cas-mismatch') throw new Error(CHANGED(refStr))
  if (wr.kind === 'error')
    throw new Error(
      `Vault refused the write (HTTP ${wr.status}): ${wr.errors.join('; ') || 'unknown error'}`
    )
  const back = await readData(cfg, mount, path, wr.meta.version)
  return {
    written: Object.keys(src.data),
    skipped: [],
    snapshot,
    version: { base: expectedVersion, next: wr.meta.version },
    verified: back.kind === 'ok' && canon(back.data) === canon(src.data)
  }
}
