import { readFile, writeFile, rename, stat, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { safeStorage } from 'electron'
import { parseEnv, patchEnv, rawAssignment } from '@shared/env-file'
import type { ApplyRequest, ApplyResult } from '@shared/channels'
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

function seal(bytes: Buffer): Buffer | null {
  return safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(bytes.toString('base64'))
    : null
}
function unseal(blob: Buffer): Buffer {
  return Buffer.from(safeStorage.decryptString(blob), 'base64')
}

async function snapshot(store: Store, path: string, reason: 'apply' | 'rollback'): Promise<number> {
  const [bytes, st] = await Promise.all([readFile(path), stat(path)])
  return store.saveSnapshot({
    path,
    at: Date.now(),
    reason,
    mtime: st.mtimeMs,
    size: st.size,
    keys: parseEnv(bytes.toString('utf8')).map((e) => e.key),
    blob: seal(bytes)
  })
}

async function atomicWrite(path: string, text: string): Promise<void> {
  const tmp = join(dirname(path), `.${randomBytes(6).toString('hex')}.drift-tmp`)
  const mode = (await stat(path).catch(() => null))?.mode
  try {
    await writeFile(tmp, text, mode !== undefined ? { mode } : undefined)
    await rename(tmp, path)
  } catch (e) {
    await unlink(tmp).catch(() => {})
    throw e
  }
}

export async function applyPlan(store: Store, req: ApplyRequest): Promise<ApplyResult> {
  assertGranted(req.left)
  assertGranted(req.right)
  const st = await stat(req.right)
  // Allow sub-millisecond jitter across filesystems, refuse a real change.
  if (Math.abs(st.mtimeMs - req.expectedMtime) > 1) {
    throw new Error(`${req.right} changed since this plan was made. Compare again, then apply.`)
  }
  const [leftText, rightText] = await Promise.all([
    readFile(req.left, 'utf8'),
    readFile(req.right, 'utf8')
  ])
  const leftValues = new Map(parseEnv(leftText).map((e) => [e.key, e.value]))
  const assignments: { key: string; text: string }[] = []
  const skipped: ApplyResult['skipped'] = []
  for (const key of req.keys) {
    const raw = rawAssignment(leftText, key)
    if (raw === null) skipped.push({ key, reason: 'not in source' })
    else if ((leftValues.get(key) ?? '') === '') skipped.push({ key, reason: 'blank in source' })
    else assignments.push({ key, text: raw })
  }
  if (assignments.length === 0) throw new Error('Nothing to write: every key was skipped.')
  const snap = await snapshot(store, req.right, 'apply')
  // Re-check right before the rename: sealing the snapshot took time and another
  // process may have written B meanwhile. Patch against what is on disk now.
  const st2 = await stat(req.right)
  if (st2.mtimeMs !== st.mtimeMs || st2.size !== st.size) {
    throw new Error(
      `${req.right} changed while preparing the write. Rescan, compare again, then apply.`
    )
  }
  await atomicWrite(req.right, patchEnv(rightText, assignments))
  return { written: assignments.map((a) => a.key), skipped, snapshot: snap }
}

export async function rollback(store: Store, id: number): Promise<void> {
  const s = store.snapshotBlob(id)
  if (!s) throw new Error('Snapshot not found')
  if (!s.blob)
    throw new Error('This snapshot has no content: no keyring was available when it was taken.')
  assertGranted(s.path)
  const text = unseal(s.blob).toString('utf8')
  // A deleted file has nothing to snapshot; restoring it is the point.
  await snapshot(store, s.path, 'rollback').catch((e) => {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  })
  await atomicWrite(s.path, text)
}
