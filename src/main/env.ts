import { baseRef, readEnv, readText } from './fs'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import type { Store } from './store'
import { parseEnv } from '@shared/env-file'
import { compareEnv, OPAQUE_FINGERPRINT, type DriftReceipt, type KeyEntry } from '@shared/drift'
import type { EnvShape } from '@shared/channels'
import { assertGranted } from './workspace'

/**
 * HMAC key for fingerprints. Per install when the OS keyring can seal it
 * (safeStorage), so receipts and history stay comparable across launches;
 * per session otherwise. Never written anywhere in the clear.
 */
let key: Buffer = randomBytes(32)
let persisted = false

export function loadFingerprintKey(
  read: () => string | null,
  write: (sealed: string) => void,
  seal: {
    isEncryptionAvailable: () => boolean
    encryptString: (s: string) => Buffer
    decryptString: (b: Buffer) => string
  }
): boolean {
  if (!seal.isEncryptionAvailable()) return (persisted = false)
  const sealed = read()
  if (sealed) {
    try {
      const k = Buffer.from(seal.decryptString(Buffer.from(sealed, 'base64')), 'base64')
      if (k.length === 32) {
        key = k
        return (persisted = true)
      }
    } catch {
      // Keyring changed, data copied from another machine, or blob corrupt: fall through
      // and seal a fresh key. Old receipts simply stop being comparable to new ones.
    }
  }
  write(seal.encryptString(key.toString('base64')).toString('base64'))
  return (persisted = true)
}

export const fingerprintKeyPersisted = (): boolean => persisted

export function fingerprint(value: string): string {
  return createHmac('sha256', key).update(value).digest('base64url').slice(0, 16)
}

/** Read a granted file and return its redacted shape. Raw values die here. */
export async function envShape(path: string): Promise<EnvShape> {
  assertGranted(path)
  const { text, opaque } = await readEnv(path)
  // Opacity comes from provider metadata only; the text of a value never decides it.
  const entries: KeyEntry[] = parseEnv(text).map(({ key, value }) => ({
    key,
    fingerprint: value === '' ? null : opaque.has(key) ? OPAQUE_FINGERPRINT : fingerprint(value)
  }))
  return { path, name: baseRef(path), entries }
}

/**
 * The one path where a raw value crosses to the renderer, and only for a single
 * key, after the caller has passed OS authentication. Returns null for a key
 * that is not in the file.
 */
export async function revealValue(path: string, key: string): Promise<string | null> {
  assertGranted(path)
  const text = await readText(path)
  // Last assignment wins, matching dotenv and the fingerprint used in receipts.
  return parseEnv(text).findLast((e) => e.key === key)?.value ?? null
}

/** Every effective value of a file (last assignment wins). Same guard as revealValue. */
export async function revealAllValues(path: string): Promise<Record<string, string>> {
  assertGranted(path)
  const text = await readText(path)
  return Object.fromEntries(parseEnv(text).map((e) => [e.key, e.value]))
}

export async function compareFiles(
  left: string,
  right: string,
  ignore: string[]
): Promise<DriftReceipt> {
  const [l, r] = await Promise.all([envShape(left), envShape(right)])
  return compareEnv(l, r, ignore)
}

/**
 * Digest of the ordered pair (refs and redacted shapes). Fingerprints are keyed
 * HMACs, so the digest says nothing about values; it only lets an apply prove
 * that the plan was made for exactly this A -> B and that neither side moved.
 */
export const shapeGuard = (left: string, right: string, l: EnvShape, r: EnvShape): string =>
  createHash('sha256')
    .update(JSON.stringify([left, right, l.entries, r.entries]))
    .digest('base64url')

/** Compare and store the receipt with its guard; the returned receipt carries the stored id. */
export async function compareGuarded(
  store: Store,
  left: string,
  right: string,
  ignore: string[]
): Promise<{ receipt: DriftReceipt; guard: string }> {
  const [l, r] = await Promise.all([envShape(left), envShape(right)])
  const receipt = compareEnv(l, r, ignore)
  const guard = shapeGuard(left, right, l, r)
  const id = store.saveReceipt(receipt, guard, { left, right })
  return { receipt: { ...receipt, id }, guard }
}

/**
 * A plan authorizes one ordered pair. Refuse when the receipt was made for a
 * different A or B (Apply is directional: B -> A is another plan), then re-read
 * both sides and refuse when either shape moved since.
 */
export async function assertPlanFresh(
  store: Store,
  id: number,
  left: string,
  right: string
): Promise<void> {
  const stored = store.receiptGuard(id)
  if (!stored) throw new Error('This plan is unknown or too old. Compare again, then apply.')
  if (stored.left !== left || stored.right !== right)
    throw new Error(
      'This plan was made for a different pair (or the other direction). Compare A and B again, then apply.'
    )
  const [l, r] = await Promise.all([envShape(left), envShape(right)])
  if (shapeGuard(left, right, l, r) !== stored.guard)
    throw new Error('A or B changed since this plan was made. Compare again, then apply.')
}
