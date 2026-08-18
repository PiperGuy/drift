import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { createHmac, randomBytes } from 'node:crypto'
import { parseEnv } from '@shared/env-file'
import { compareEnv, type DriftReceipt, type KeyEntry } from '@shared/drift'
import type { EnvShape } from '@shared/channels'
import { assertGranted } from './workspace'

/**
 * Per-session HMAC key. Fingerprints only need to agree with each other for
 * as long as the app runs, so a fresh key each launch means a fingerprint
 * that leaves the process is useless for guessing low-entropy values.
 */
const sessionKey = randomBytes(32)

export function fingerprint(value: string): string {
  return createHmac('sha256', sessionKey).update(value).digest('base64url').slice(0, 16)
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
