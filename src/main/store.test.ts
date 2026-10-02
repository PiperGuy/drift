import { test } from 'vitest'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
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

test('store: preserves legacy license history events', () => {
  const dir = mkdtempSync(join(tmpdir(), 'plumbr-store-legacy-'))
  const file = join(dir, 'plumbr.db')
  try {
    // Simulate an event written by an older release, before licensing was removed.
    openStore(file).close()
    const db = new DatabaseSync(file)
    db.prepare('INSERT INTO events (at, kind, subject_json, detail_json) VALUES (?, ?, ?, ?)').run(
      1,
      'license',
      JSON.stringify({ name: 'Prior user' }),
      '{}'
    )
    db.close()

    const s = openStore(file)
    assert.equal(s.listEvents()[0].kind, 'license')
    s.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('workspaces: default exists, roots scoped to the active one, delete cascades', () => {
  const dir = mkdtempSync(join(tmpdir(), 'plumbr-ws-'))
  try {
    const s = openStore(join(dir, 'plumbr.db'))
    assert.deepEqual(
      s.listWorkspaces().map((w) => w.name),
      ['Default']
    )
    assert.equal(s.activeWorkspace(), 1)
    s.rememberRoot('/a')
    const w = s.createWorkspace('Client X')
    s.setActiveWorkspace(w.id)
    s.rememberRoot('ssh://vps/srv')
    assert.deepEqual(
      s.listRoots().map((r) => r.path),
      ['ssh://vps/srv']
    )
    s.setActiveWorkspace(1)
    assert.deepEqual(
      s.listRoots().map((r) => r.path),
      ['/a']
    )
    assert.deepEqual(
      s.listWorkspaces().map((x) => [x.roots, x.path]),
      [
        [1, '/a'],
        [1, 'ssh://vps/srv']
      ]
    )
    s.deleteWorkspace(w.id)
    assert.deepEqual(
      s.listWorkspaces().map((x) => x.name),
      ['Default']
    )
    s.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
