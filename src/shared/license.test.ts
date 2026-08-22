import { test } from 'vitest'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { licenseState, verifyLicense, TRIAL_MS } from './license'

const DAY = 86_400_000
const now = 1_800_000_000_000

test('trial: 7 days, then expired; clock rollback locks', () => {
  const base = { key: null, trialStartedAt: now, lastSeen: now }
  assert.deepEqual(licenseState(base, now), { state: 'trial', endsAt: now + TRIAL_MS, daysLeft: 7 })
  assert.equal(licenseState(base, now + 6.5 * DAY).state, 'trial')
  assert.deepEqual(licenseState(base, now + 7 * DAY), { state: 'expired', reason: 'trial' })
  assert.deepEqual(licenseState({ ...base, lastSeen: now + 3 * DAY }, now), {
    state: 'expired',
    reason: 'clock'
  })
})

test('license: garbage and wrong-key signatures rejected', () => {
  assert.equal(verifyLicense('DRIFT-abc.def'), null)
  assert.equal(verifyLicense('nope'), null)
  // A key signed by some other private key must not verify against the embedded public key.
  const { privateKey } = generateKeyPairSync('ed25519')
  const priv = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')
  const forged = execFileSync('node', ['scripts/license.mjs', 'issue', 'eve'], {
    env: { ...process.env, DRIFT_LICENSE_PRIVATE_KEY: priv }
  })
    .toString()
    .trim()
  assert.match(forged, /^DRIFT-/)
  assert.equal(verifyLicense(forged), null)
  assert.deepEqual(licenseState({ key: forged, trialStartedAt: now, lastSeen: now }, now), {
    state: 'expired',
    reason: 'license'
  })
})

test('license: key issued with the dev private key verifies (skipped without it)', (t) => {
  const priv = process.env.DRIFT_LICENSE_PRIVATE_KEY
  if (!priv) return t.skip()
  const key = execFileSync('node', ['scripts/license.mjs', 'issue', 'naveen@example.com', '30'])
    .toString()
    .trim()
  const p = verifyLicense(key)
  assert.equal(p?.n, 'naveen@example.com')
  assert.equal(licenseState({ key, trialStartedAt: 0, lastSeen: 0 }).state, 'licensed')
})
