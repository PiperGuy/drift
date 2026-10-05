import { randomUUID } from 'node:crypto'
import { isVaultMount, isVaultSegment } from '@shared/ipc'
import type { VaultHistory, VaultListing, VaultMount, VaultNode } from '@shared/channels'
import { list, listMounts, readMetadata, uiMount, VaultHttpError, type VaultConfig } from './client'

/**
 * Browse Vault sessions: a signed-in token held in main while the Add source
 * dialog browses, so the renderer only ever holds an opaque session id.
 * Metadata only — nothing here reads /data/, so no secret value is fetched.
 * Never persisted; idle sessions expire and only a few may exist at once.
 */
type Session = {
  cfg: VaultConfig
  authKind: 'token' | 'approle'
  at: number
  /** KV v2 mounts this session listed or confirmed; the only ones it will browse. */
  mounts: Set<string>
}
const sessions = new Map<string, Session>()
const IDLE_MS = 30 * 60_000
const MAX_SESSIONS = 4
/** Children shown per folder; Vault's KV v2 LIST has no pagination to ask for fewer. */
export const LIST_CAP = 500
const LIST_BYTES = 4 * 1024 * 1024
const SYSTEM_MOUNTS = new Set(['sys', 'identity', 'cubbyhole'])

const sweep = (now: number): void => {
  for (const [id, s] of sessions) if (now - s.at > IDLE_MS) sessions.delete(id)
}

export function openDiscovery(
  cfg: VaultConfig,
  authKind: 'token' | 'approle',
  mounts: VaultMount[] | null
): string {
  const now = Date.now()
  sweep(now)
  while (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value!)
  const id = randomUUID()
  sessions.set(id, { cfg, authKind, at: now, mounts: new Set(mounts?.map((m) => m.path)) })
  return id
}

export function discoverySession(id: string): Session {
  const now = Date.now()
  sweep(now)
  const s = sessions.get(id)
  if (!s) throw new Error('This Vault browse session has ended. Sign in again to browse.')
  s.at = now
  return s
}

/**
 * A browse call may only touch a mount the session confirmed as KV v2, so a
 * crafted mount such as `secret/data` or a KV v1 mount can never turn a
 * "metadata" request into a read of secret values.
 */
function kv2Session(id: string, mount: string): Session {
  const s = discoverySession(id)
  if (!s.mounts.has(mount))
    throw new Error(`${mount} is not a KV v2 mount in this browse session. Open it by path first.`)
  return s
}

export function endDiscovery(id?: string): void {
  if (id === undefined) sessions.clear()
  else sessions.delete(id)
}

/** KV v2 mounts the token can see, or null with a reason it cannot enumerate them. */
export async function listMountsSafe(
  cfg: VaultConfig
): Promise<{ mounts: VaultMount[] | null; note: string | null }> {
  try {
    const { mounts } = await listMounts(cfg)
    const kv2 = mounts
      .filter((m) => m.type === 'kv' && m.version === '2' && isVaultMount(m.path))
      .map((m) => ({ path: m.path, description: m.description.slice(0, 200) }))
      .sort((a, b) => a.path.localeCompare(b.path))
    const skipped = mounts.filter(
      (m) => !(m.type === 'kv' && m.version === '2') && !SYSTEM_MOUNTS.has(m.path)
    ).length
    return {
      mounts: kv2,
      note:
        skipped > 0
          ? `${skipped} other mount${skipped === 1 ? '' : 's'} (KV v1 or other engines) not shown: Drift browses KV v2 only.`
          : null
    }
  } catch (e) {
    return {
      mounts: null,
      note:
        e instanceof VaultHttpError && (e.status === 403 || e.status === 404)
          ? 'This token may not list mounts (that needs read on sys/mounts). Type a KV v2 mount or path you know, e.g. secret or secret/apps, to browse from there.'
          : `Could not list mounts: ${e instanceof Error ? e.message : String(e)}. Type a mount or path to browse from there.`
    }
  }
}

/** Resolve a typed path to its KV v2 mount, for tokens that cannot enumerate mounts. */
export async function discoverMount(
  id: string,
  path: string
): Promise<{ mount: VaultMount; folder: string; secret: boolean }> {
  const s = discoverySession(id)
  // Only Vault's mount table may say what a typed path is. Probing candidate
  // prefixes (`<x>/config`, `<x>/metadata/...`) would read secret values on a
  // KV v1 mount, so when the lookup is refused, browsing fails closed.
  const m = await uiMount(s.cfg, path)
  if (!m)
    throw new Error(
      `${path}: Vault would not say which mount this is on (this token may not use sys/internal/ui/mounts). Drift does not guess while browsing: ask for that access, or switch to "Enter a path" to connect it directly.`
    )
  if (m.kvVersion !== '2')
    throw new Error(
      m.kvVersion === '1'
        ? `${m.mount} is a KV version 1 mount. Drift browses KV v2 only.`
        : `${path}: could not confirm a KV v2 mount here (check the name and your policy).`
    )
  // The mount name came from Vault: hold it to the same rules as typed input.
  if (!isVaultMount(m.mount)) throw new Error(`${path}: Vault named an invalid mount.`)
  s.mounts.add(m.mount)
  const folder =
    path === m.mount ? '' : path.startsWith(`${m.mount}/`) ? path.slice(m.mount.length + 1) : ''
  // Is the typed path one secret rather than a folder? One capped metadata read;
  // any refusal just means "browse it as a folder".
  const secret =
    folder !== '' &&
    (await readMetadata(s.cfg, m.mount, folder, LIST_BYTES).then(
      (meta) => meta !== null,
      () => false
    ))
  return { mount: { path: m.mount, description: '' }, folder, secret }
}

/** One level of <mount>/metadata/<folder>. Lazy: the renderer asks per expansion. */
export async function discoverList(
  id: string,
  mount: string,
  folder: string
): Promise<VaultListing> {
  const { cfg } = kv2Session(id, mount)
  let res: Awaited<ReturnType<typeof list>>
  try {
    res = await list(cfg, mount, folder, LIST_BYTES)
  } catch (e) {
    const where = `${mount}/metadata/${folder}`.replace(/\/$/, '')
    if (e instanceof VaultHttpError && e.status === 403)
      return {
        state: 'error',
        denied: true,
        message: `No list permission on ${where}. Siblings you can list are unaffected.`
      }
    return { state: 'error', denied: false, message: e instanceof Error ? e.message : String(e) }
  }
  if ('empty' in res) return { state: 'empty' }
  const nodes: VaultNode[] = []
  for (const key of res.keys) {
    const isFolder = key.endsWith('/')
    const name = isFolder ? key.slice(0, -1) : key
    if (!isVaultSegment(name)) continue
    nodes.push({
      name,
      path: folder ? `${folder}/${name}` : name,
      kind: isFolder ? 'folder' : 'secret'
    })
  }
  // Folders first (apps and groups), then secrets; each alphabetical.
  nodes.sort((a, b) =>
    a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'folder' ? -1 : 1
  )
  return { state: 'ok', nodes: nodes.slice(0, LIST_CAP), truncated: nodes.length > LIST_CAP }
}

/** Version timeline of one secret while browsing. Metadata only, no values. */
export async function discoverVersions(
  id: string,
  mount: string,
  path: string
): Promise<VaultHistory> {
  const { cfg } = kv2Session(id, mount)
  const meta = await readMetadata(cfg, mount, path, LIST_BYTES)
  if (!meta) throw new Error(`${mount}/${path}: no metadata (deleted, or no metadata read).`)
  return {
    path: `${mount}/${path}`,
    currentVersion: meta.currentVersion,
    oldestVersion: meta.oldestVersion,
    maxVersions: meta.maxVersions,
    casRequired: meta.casRequired,
    deleteVersionAfter: meta.deleteVersionAfter,
    updatedTime: meta.updatedTime,
    versions: meta.versions
  }
}
