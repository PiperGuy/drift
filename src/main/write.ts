import { isReadOnlyRef, parseRef, readEnv, readText, statRef, writeAtomic } from './fs'
import { applyVault } from './providers/vault'
import { safeStorage } from 'electron'
import { parseEnv, patchEnv, rawAssignment } from '@shared/env-file'
import { formatEnv, renderAssignment } from '@shared/env-lint'
import type {
  ApplyRequest,
  ApplyResult,
  FormatResult,
  SetRequest,
  SetResult,
  Snapshot
} from '@shared/channels'
import { assertGranted } from './workspace'
import type { Store } from './store'

/**
 * The only code that writes an env file. Every write:
 *   1. refuses if the target changed since the plan was made (mtime guard),
 *   2. snapshots the target into file_history (bytes sealed by the OS keyring),
 *   3. writes a temp file next to the target and renames it over (atomic on POSIX and NTFS),
 *   4. preserves the target's mode.
 * Raw values exist here only between read and write. Nothing is logged but key names.
 */

const READ_ONLY = (ref: string): string =>
  `${parseRef(ref).kind === 'vault' ? 'Vault environments' : 'Provider sources'} are read-only here. ${
    parseRef(ref).kind === 'vault'
      ? 'Change them through Compare \u2192 Apply, or restore a version from their history.'
      : 'Change values in the provider itself, then rescan.'
  }`

function seal(bytes: Buffer): Buffer | null {
  return safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(bytes.toString('base64'))
    : null
}
function unseal(blob: Buffer): Buffer {
  return Buffer.from(safeStorage.decryptString(blob), 'base64')
}

async function snapshot(store: Store, path: string, reason: Snapshot['reason']): Promise<number> {
  const [text, st] = await Promise.all([readText(path), statRef(path)])
  const bytes = Buffer.from(text, 'utf8')
  return store.saveSnapshot({
    path,
    at: Date.now(),
    reason,
    mtime: st.mtimeMs,
    size: st.size,
    keys: parseEnv(text).map((e) => e.key),
    blob: seal(bytes)
  })
}

export async function applyPlan(store: Store, req: ApplyRequest): Promise<ApplyResult> {
  assertGranted(req.left)
  assertGranted(req.right)
  if (isReadOnlyRef(req.right)) throw new Error(READ_ONLY(req.right))
  // Vault targets are guarded by check-and-set on the version, not by mtime.
  if (parseRef(req.right).kind === 'vault') return applyVault(store, req)
  const st = await statRef(req.right)
  // Allow sub-millisecond jitter across filesystems, refuse a real change.
  if (Math.abs(st.mtimeMs - req.expectedMtime) > 1) {
    throw new Error(`${req.right} changed since this plan was made. Compare again, then apply.`)
  }
  const [{ text: leftText, opaque }, rightText] = await Promise.all([
    readEnv(req.left),
    readText(req.right)
  ])
  const leftValues = new Map(parseEnv(leftText).map((e) => [e.key, e.value]))
  const assignments: { key: string; text: string }[] = []
  const skipped: ApplyResult['skipped'] = []
  for (const key of req.keys) {
    const raw = rawAssignment(leftText, key)
    if (raw === null) skipped.push({ key, reason: 'not in source' })
    else if ((leftValues.get(key) ?? '') === '') skipped.push({ key, reason: 'blank in source' })
    else if (opaque.has(key)) skipped.push({ key, reason: 'value not readable from source' })
    else assignments.push({ key, text: raw })
  }
  if (assignments.length === 0) throw new Error('Nothing to write: every key was skipped.')
  const snap = await snapshot(store, req.right, 'apply')
  // Re-check right before the rename: sealing the snapshot took time and another
  // process may have written B meanwhile. Patch against what is on disk now.
  const st2 = await statRef(req.right)
  if (st2.mtimeMs !== st.mtimeMs || st2.size !== st.size) {
    throw new Error(
      `${req.right} changed while preparing the write. Rescan, compare again, then apply.`
    )
  }
  await writeAtomic(req.right, patchEnv(rightText, assignments))
  return { written: assignments.map((a) => a.key), skipped, snapshot: snap }
}

/** Rewrite a file in canonical form. Same guards and snapshot as apply. */
export async function formatFile(
  store: Store,
  path: string,
  expectedMtime: number
): Promise<FormatResult> {
  assertGranted(path)
  if (parseRef(path).kind === 'vault' || isReadOnlyRef(path)) throw new Error(READ_ONLY(path))
  const st = await statRef(path)
  if (Math.abs(st.mtimeMs - expectedMtime) > 1)
    throw new Error(`${path} changed since it was opened. Rescan, then format.`)
  const before = await readText(path)
  const after = formatEnv(before)
  if (after === before) return { changed: 0, snapshot: null }
  const a = before.split(/\r?\n/)
  const b = after.split('\n')
  let changed = 0
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) changed++
  const snap = await snapshot(store, path, 'format')
  const st2 = await statRef(path)
  if (st2.mtimeMs !== st.mtimeMs || st2.size !== st.size)
    throw new Error(`${path} changed while preparing the write. Rescan, then format.`)
  await writeAtomic(path, after)
  return { changed, snapshot: snap }
}

/** Write user-typed values: update in place or append. Same guards and snapshot as apply. */
export async function setValues(store: Store, req: SetRequest): Promise<SetResult> {
  assertGranted(req.path)
  if (parseRef(req.path).kind === 'vault' || isReadOnlyRef(req.path))
    throw new Error(READ_ONLY(req.path))
  const st = await statRef(req.path)
  if (Math.abs(st.mtimeMs - req.expectedMtime) > 1)
    throw new Error(`${req.path} changed since it was opened. Rescan, then edit again.`)
  const text = await readText(req.path)
  const assignments = req.entries.map((e) => ({
    key: e.key,
    text: renderAssignment(text, e.key, e.value)
  }))
  const snap = await snapshot(store, req.path, 'edit')
  const st2 = await statRef(req.path)
  if (st2.mtimeMs !== st.mtimeMs || st2.size !== st.size)
    throw new Error(`${req.path} changed while preparing the write. Rescan, then edit again.`)
  await writeAtomic(req.path, patchEnv(text, assignments))
  return { written: assignments.map((a) => a.key), snapshot: snap }
}

export async function rollback(store: Store, id: number): Promise<void> {
  const s = store.snapshotBlob(id)
  if (!s) throw new Error('Snapshot not found')
  if (parseRef(s.path).kind === 'vault')
    throw new Error(
      'Vault environments roll back from their own version history (open the file \u2192 History), not from file snapshots.'
    )
  if (isReadOnlyRef(s.path)) throw new Error(READ_ONLY(s.path))
  if (!s.blob)
    throw new Error('This snapshot has no content: no keyring was available when it was taken.')
  assertGranted(s.path)
  const text = unseal(s.blob).toString('utf8')
  // A deleted file has nothing to snapshot; restoring it is the point.
  await snapshot(store, s.path, 'rollback').catch((e) => {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  })
  await writeAtomic(s.path, text)
}
