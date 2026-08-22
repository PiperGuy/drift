import { licenseState, verifyLicense, type LicenseState } from '@shared/license'
import type { Store } from './store'

/**
 * Trial and license live in the store's meta table. `last_seen` is bumped on every
 * check so a clock rolled back past it locks the app instead of extending the trial.
 */
export function currentLicense(store: Store, now = Date.now()): LicenseState {
  let started = Number(store.getMeta('trial_started_at'))
  if (!started) {
    started = now
    store.setMeta('trial_started_at', String(now))
  }
  const lastSeen = Number(store.getMeta('last_seen') ?? 0)
  if (now > lastSeen) store.setMeta('last_seen', String(now))
  return licenseState({ key: store.getMeta('license_key'), trialStartedAt: started, lastSeen }, now)
}

export function activate(store: Store, key: string): LicenseState {
  const p = verifyLicense(key)
  if (!p) throw new Error('That key is not valid for this build, or it has expired.')
  store.setMeta('license_key', key.trim())
  return currentLicense(store)
}

/** Throw unless the app is in trial or licensed. Guards every data IPC. */
export function assertUnlocked(store: Store): void {
  const s = currentLicense(store)
  if (s.state === 'expired')
    throw new Error('LOCKED: trial ended. Enter a license key in Settings.')
}
