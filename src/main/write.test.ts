import { test, vi } from 'vitest'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// safeStorage stand-in: reversible, so rollback can be exercised without a keyring.
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from('sealed:' + s),
    decryptString: (b: Buffer) => b.toString().slice('sealed:'.length)
  }
}))

const { applyPlan, rollback, setValues } = await import('./write')
const { openStore } = await import('./store')
const { grantRoot } = await import('./workspace')

test('apply: mtime guard, snapshot, in-place patch, rollback restores bytes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'drift-write-'))
  try {
    grantRoot(dir)
    const left = join(dir, '.env')
    const right = join(dir, '.env.production')
    writeFileSync(left, 'DATABASE_URL="postgres://new" # prod\nNEW_KEY=1\nBLANK=\n')
    const original = '# keep me\nDATABASE_URL=old\nEXTRA=stays\n'
    writeFileSync(right, original)
    const store = openStore(join(dir, 'plumbr.db'))
    const mtime = statSync(right).mtimeMs

    // Stale plan is refused and the file is untouched.
    await assert.rejects(
      applyPlan(store, { left, right, keys: ['NEW_KEY'], expectedMtime: mtime - 5000 }),
      /changed since/
    )
    assert.equal(readFileSync(right, 'utf8'), original)

    const r = await applyPlan(store, {
      left,
      right,
      keys: ['DATABASE_URL', 'NEW_KEY', 'BLANK', 'NOPE'],
      expectedMtime: mtime
    })
    assert.deepEqual(r.written, ['DATABASE_URL', 'NEW_KEY'])
    assert.deepEqual(r.skipped, [
      { key: 'BLANK', reason: 'blank in source' },
      { key: 'NOPE', reason: 'not in source' }
    ])
    // Assignment copied verbatim, comment and extra key preserved, new key appended.
    assert.equal(
      readFileSync(right, 'utf8'),
      '# keep me\nDATABASE_URL="postgres://new" # prod\nEXTRA=stays\nNEW_KEY=1\n'
    )
    // Snapshot recorded key names only in the clear; bytes sealed.
    const snaps = store.listSnapshots()
    assert.equal(snaps.length, 1)
    assert.deepEqual(snaps[0].keys, ['DATABASE_URL', 'EXTRA'])
    assert.ok(snaps[0].restorable)
    assert.ok(!JSON.stringify(store.listEvents()).includes('postgres'))

    // Rollback puts the original bytes back and snapshots the current state first.
    utimesSync(right, new Date(), new Date())
    await rollback(store, snaps[0].id)
    assert.equal(readFileSync(right, 'utf8'), original)
    assert.equal(store.listSnapshots().length, 2)
    assert.equal(store.listSnapshots()[0].reason, 'rollback')
    store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('setValues: updates in place keeping export/comment, appends new keys, quotes when needed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'drift-edit-'))
  try {
    grantRoot(dir)
    const f = join(dir, '.env')
    writeFileSync(f, '# hi\nexport TOKEN=old # rotate monthly\nPORT=3000\n')
    const store = openStore(join(dir, 'plumbr.db'))
    const r = await setValues(store, {
      path: f,
      expectedMtime: statSync(f).mtimeMs,
      entries: [
        { key: 'TOKEN', value: 'new value' },
        { key: 'NEW', value: 'x' }
      ]
    })
    assert.deepEqual(r.written, ['TOKEN', 'NEW'])
    assert.equal(
      readFileSync(f, 'utf8'),
      '# hi\nexport TOKEN="new value" # rotate monthly\nPORT=3000\nNEW=x\n'
    )
    assert.equal(store.listSnapshots()[0].reason, 'edit')
    store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('apply: provider targets are refused; a local value that merely looks like the opaque marker is ordinary', async () => {
  const { OPAQUE_VALUE, OPAQUE_FINGERPRINT } = await import('@shared/drift')
  const { envShape } = await import('./env')
  const dir = mkdtempSync(join(tmpdir(), 'drift-opaque-'))
  try {
    grantRoot(dir)
    const store = openStore(join(dir, 'plumbr.db'))
    const left = join(dir, 'opaque.env')
    const right = join(dir, 'target.env')
    writeFileSync(left, `A=1\nSECRET="${OPAQUE_VALUE}"\n`)
    writeFileSync(right, 'A=0\n')
    // Opacity is provider metadata, never inferred from the text: this literal is a normal value.
    const fp = (await envShape(left)).entries.find((e) => e.key === 'SECRET')!.fingerprint
    assert.notEqual(fp, OPAQUE_FINGERPRINT)
    assert.ok(fp)
    const mtime = statSync(right).mtimeMs
    const r = await applyPlan(store, { left, right, keys: ['A', 'SECRET'], expectedMtime: mtime })
    assert.deepEqual(r.written, ['A', 'SECRET'])
    assert.deepEqual(r.skipped, [])
    assert.ok(readFileSync(right, 'utf8').includes(`SECRET="${OPAQUE_VALUE}"`))
    grantRoot('github://1/acme/api')
    await assert.rejects(
      applyPlan(store, {
        left,
        right: 'github://1/acme/api/.env',
        keys: ['A'],
        expectedMtime: 0
      }),
      /read-only/
    )
    store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
