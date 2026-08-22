import { verify, createPublicKey } from 'node:crypto'
import { LICENSE_PUBKEY } from './license-pubkey'

/** 7 days, then the app locks until a key is entered. */
export const TRIAL_MS = 7 * 86_400_000

export type LicensePayload = { n: string; i: number; e: number | null }

export type LicenseState =
  | { state: 'trial'; endsAt: number; daysLeft: number }
  | { state: 'licensed'; name: string; expiresAt: number | null }
  | { state: 'expired'; reason: 'trial' | 'license' | 'clock' }

/** Parse and verify a `DRIFT-<payload>.<sig>` key. Returns null for anything invalid. */
export function verifyLicense(key: string, now = Date.now()): LicensePayload | null {
  const m = /^DRIFT-([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(key.trim())
  if (!m) return null
  try {
    const data = Buffer.from(m[1], 'base64url')
    const sig = Buffer.from(m[2], 'base64url')
    const pub = createPublicKey({
      key: Buffer.from(LICENSE_PUBKEY, 'base64'),
      format: 'der',
      type: 'spki'
    })
    if (!verify(null, data, pub, sig)) return null
    const p = JSON.parse(data.toString()) as LicensePayload
    if (typeof p.n !== 'string' || typeof p.i !== 'number') return null
    if (p.e !== null && (typeof p.e !== 'number' || p.e < now)) return null
    return p
  } catch {
    return null
  }
}

/**
 * Decide what the app may do. `lastSeen` is the newest timestamp the app has ever
 * observed; a clock set back before it by more than a day is treated as tampering.
 */
export function licenseState(
  opts: { key: string | null; trialStartedAt: number; lastSeen: number },
  now = Date.now()
): LicenseState {
  // A valid key always wins, so entering one recovers a clock lock.
  if (opts.key) {
    const p = verifyLicense(opts.key, now)
    if (p) return { state: 'licensed', name: p.n, expiresAt: p.e }
    return { state: 'expired', reason: 'license' }
  }
  if (now < opts.lastSeen - 86_400_000) return { state: 'expired', reason: 'clock' }
  const endsAt = opts.trialStartedAt + TRIAL_MS
  if (now >= endsAt) return { state: 'expired', reason: 'trial' }
  return { state: 'trial', endsAt, daysLeft: Math.ceil((endsAt - now) / 86_400_000) }
}
