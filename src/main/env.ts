import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { createHmac, randomBytes } from 'node:crypto'
import { parseEnv } from '@shared/env-file'
import { compareEnv, type DriftReceipt, type KeyEntry } from '@shared/drift'
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
    key = Buffer.from(seal.decryptString(Buffer.from(sealed, 'base64')), 'base64')
  } else {
    write(seal.encryptString(key.toString('base64')).toString('base64'))
  }
  return (persisted = true)
}

export const fingerprintKeyPersisted = (): boolean => persisted

export function fingerprint(value: string): string {
  return createHmac('sha256', key).update(value).digest('base64url').slice(0, 16)
}

/** Read a granted file and return its redacted shape. Raw values die here. */
export async function envShape(path: string): Promise<EnvShape> {
  assertGranted(path)
  const text = await readFile(path, 'utf8')
  const entries: KeyEntry[] = parseEnv(text).map(({ key, value }) => ({
    key,
    fingerprint: value === '' ? null : fingerprint(value)
  }))
  return { path, name: basename(path), entries }
}

export async function compareFiles(
  left: string,
  right: string,
  ignore: string[]
): Promise<DriftReceipt> {
  const [l, r] = await Promise.all([envShape(left), envShape(right)])
  return compareEnv(l, r, ignore)
}
