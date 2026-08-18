import { test } from 'vitest'
import assert from 'node:assert/strict'
import { compareEnv, planSync, toMcpContext } from './drift'

const staging = {
  name: '.env.staging',
  entries: [
    { key: 'DATABASE_URL', fingerprint: 'a1' },
    { key: 'STRIPE_KEY', fingerprint: 'b2' },
    { key: 'FEATURE_FLAGS', fingerprint: 'c3' },
    { key: 'SENTRY_DSN', fingerprint: null },
    { key: 'NODE_ENV', fingerprint: 's' }
  ]
}

const production = {
  name: '.env.production',
  entries: [
    { key: 'DATABASE_URL', fingerprint: 'a1' },
    { key: 'STRIPE_KEY', fingerprint: 'zz' },
    { key: 'SENTRY_DSN', fingerprint: 'd4' },
    { key: 'REDIS_URL', fingerprint: 'e5' },
    { key: 'NODE_ENV', fingerprint: 'p' }
  ]
}

test('compareEnv classifies every key and sorts deterministically', () => {
  const receipt = compareEnv(staging, production, ['NODE_ENV'])
  assert.deepEqual(receipt.rows, [
    { key: 'DATABASE_URL', status: 'same' },
    { key: 'FEATURE_FLAGS', status: 'missing' },
    { key: 'NODE_ENV', status: 'ignored' },
    { key: 'REDIS_URL', status: 'extra' },
    { key: 'SENTRY_DSN', status: 'blank' },
    { key: 'STRIPE_KEY', status: 'changed' }
  ])
  assert.deepEqual(receipt.counts, {
    same: 1,
    changed: 1,
    missing: 1,
    extra: 1,
    blank: 1,
    ignored: 1
  })
  assert.equal(receipt.clean, false)
})

test('compareEnv is clean when only same/ignored rows exist', () => {
  assert.equal(
    compareEnv(staging, staging, []).clean,
    false,
    'blank on both sides still needs review'
  )
  const noBlank = { name: 'x', entries: staging.entries.filter((e) => e.fingerprint !== null) }
  assert.equal(compareEnv(noBlank, noBlank).clean, true)
})

test('planSync never removes target-only keys and skips same/ignored', () => {
  const plan = planSync(compareEnv(staging, production, ['NODE_ENV']))
  assert.deepEqual(
    plan.map((a) => [a.key, a.op]),
    [
      ['FEATURE_FLAGS', 'add'],
      ['REDIS_URL', 'keep'],
      ['SENTRY_DSN', 'review'],
      ['STRIPE_KEY', 'update']
    ]
  )
})

test('toMcpContext exposes key names and classes only, values redacted', () => {
  const ctx = toMcpContext(compareEnv(staging, production, ['NODE_ENV']))
  assert.deepEqual(ctx, {
    left: '.env.staging',
    right: '.env.production',
    missing: ['FEATURE_FLAGS'],
    extra: ['REDIS_URL'],
    changed: ['STRIPE_KEY'],
    blank: ['SENTRY_DSN'],
    values: 'redacted'
  })
  assert.ok(!JSON.stringify(ctx).includes('a1'), 'fingerprints must not leak')
})
