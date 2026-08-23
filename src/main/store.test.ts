import { test } from 'vitest'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore } from './store'
import type { DriftReceipt } from '@shared/drift'

const receipt: DriftReceipt = {
  left: '/ws/a/.env',
  right: '/ws/a/.env.production',
  rows: [{ key: 'DATABASE_URL', status: 'changed' }],
  counts: { same: 0, changed: 1, missing: 0, extra: 0, blank: 0, ignored: 0 },
  clean: false
}

test('store: migrates, remembers the root, logs redacted events, survives reopen, forgets', () => {
  const dir = mkdtempSync(join(tmpdir(), 'plumbr-store-'))
  const file = join(dir, 'plumbr.db')
  try {
    let s = openStore(file)
    assert.deepEqual(s.listRoots(), [])
    assert.equal(s.getMeta('fingerprint_key_ref'), null)
    s.setMeta('fingerprint_key_ref', 'sealed')
    s.rememberRoot('/ws')
    s.logEvent('grant', { root: '/ws' })
    const id = s.saveReceipt(receipt)
    s.logEvent('compare', { left: receipt.left, right: receipt.right, receipt: id }, receipt.counts)
    s.close()

    // Reopen: migrations are idempotent, data is still there, newest first.
    s = openStore(file)
    assert.deepEqual(s.listRoots(), [{ path: '/ws', label: null }])
    assert.equal(s.getMeta('fingerprint_key_ref'), 'sealed')
    const events = s.listEvents()
    assert.deepEqual(
      events.map((e) => e.kind),
      ['compare', 'grant']
    )
    assert.equal(events[0].detail['changed'], 1)
    // Nothing that looks like a value is ever stored: only keys, classes and counts.
    assert.ok(!JSON.stringify(events).includes('postgres'))

    s.forgetAll()
    assert.deepEqual(s.listRoots(), [])
    assert.equal(s.listEvents().length, 0)
    assert.equal(s.getMeta('fingerprint_key_ref'), 'sealed')
    s.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
