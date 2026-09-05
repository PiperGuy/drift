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

test('apply: provider targets need a plan; a local value that merely looks like the opaque marker is ordinary', async () => {
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
      /plan/
    )
    store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('apply: provider targets go through the adapter with a fresh plan guard, never with opaque or blank values', async () => {
  const { registerProviderBackend } = await import('./fs')
  const { compareGuarded } = await import('./env')
  const { OPAQUE_VALUE } = await import('@shared/drift')
  const dir = mkdtempSync(join(tmpdir(), 'drift-provider-write-'))
  try {
    grantRoot(dir)
    const store = openStore(join(dir, 'plumbr.db'))
    const left = join(dir, '.env')
    writeFileSync(left, 'A=1\nB=2\nBLANK=\nSECRET=s3cret\n')
    let targetText = 'A=0\nZ=9\n'
    const calls: unknown[] = []
    registerProviderBackend('render', {
      readEnv: async () => ({ text: targetText, opaque: new Set(['Z']) }),
      readText: async () => targetText,
      stat: async () => ({ mtimeMs: 0, size: 0 }),
      scan: async () => {
        throw new Error('unused')
      },
      apply: async (_ref, w) => {
        calls.push(w)
        return { written: w.entries.map((e) => e.key), verified: true, note: 'note from adapter' }
      }
    })
    registerProviderBackend('dokploy', {
      readText: async () => 'A=0\n',
      stat: async () => ({ mtimeMs: 0, size: 0 }),
      scan: async () => {
        throw new Error('unused')
      }
    })
    grantRoot('render://1/services/svc')
    grantRoot('dokploy://1/app')
    const right = 'render://1/services/svc/.env'

    // No plan attached: refused before anything is read from the source.
    await assert.rejects(applyPlan(store, { left, right, keys: ['A'], expectedMtime: 0 }), /plan/i)
    assert.equal(calls.length, 0)

    const { receipt } = await compareGuarded(store, left, right, [])
    // Target changed between plan and apply: refused, adapter never called.
    targetText = 'A=0\nZ=9\nNEW=1\n'
    await assert.rejects(
      applyPlan(store, { left, right, keys: ['A'], expectedMtime: 0, receipt: receipt.id }),
      /changed since/
    )
    assert.equal(calls.length, 0)
    targetText = 'A=0\nZ=9\n'

    // Source changed too: same refusal.
    writeFileSync(left, 'A=1\nB=2\nBLANK=\nSECRET=other\n')
    await assert.rejects(
      applyPlan(store, { left, right, keys: ['A'], expectedMtime: 0, receipt: receipt.id }),
      /changed since/
    )
    writeFileSync(left, 'A=1\nB=2\nBLANK=\nSECRET=s3cret\n')

    // Fresh plan: opaque (Z from a names-only source side) and blank keys are skipped, the rest go to the adapter.
    const plan = await compareGuarded(store, right, left, [])
    const r = await applyPlan(store, {
      left,
      right,
      keys: ['A', 'B', 'BLANK', 'NOPE'],
      expectedMtime: 0,
      receipt: (await compareGuarded(store, left, right, [])).receipt.id
    })
    assert.ok(plan.receipt.id)
    assert.deepEqual(r.written, ['A', 'B'])
    assert.deepEqual(r.skipped, [
      { key: 'BLANK', reason: 'blank in source' },
      { key: 'NOPE', reason: 'not in source' }
    ])
    assert.equal(r.verified, true)
    assert.equal(r.note, 'note from adapter')
    assert.equal(calls.length, 1)
    const w = calls[0] as { entries: { key: string; value: string }[]; token: string }
    assert.deepEqual(w.entries, [
      { key: 'A', value: '1' },
      { key: 'B', value: '2' }
    ])
    assert.match(w.token, /^[0-9a-f-]{36}$/)
    // Shape-only snapshot: key names of the target, no restorable bytes.
    const snap = store.listSnapshots()[0]
    assert.equal(snap.path, right)
    assert.deepEqual(snap.keys, ['A', 'Z'])
    assert.equal(snap.restorable, false)

    // A source-side names-only key (Z on the provider side) is never sent, even when selected;
    // a local value that merely equals the placeholder text is ordinary and is written.
    writeFileSync(left, `A=1\nOPQ="${OPAQUE_VALUE}"\n`)
    targetText = 'Z=9\n'
    const opq = await compareGuarded(store, right, left, [])
    assert.ok(opq.receipt.id)
    const back = await applyPlan(store, {
      left: right,
      right: left,
      keys: ['Z'],
      expectedMtime: statSync(left).mtimeMs,
      receipt: opq.receipt.id
    }).catch((e: Error) => e)
    assert.match(String(back), /Nothing to write/)
    assert.ok(!readFileSync(left, 'utf8').includes('Z='))

    // Adapters without a write path are refused with an actionable message.
    await assert.rejects(
      applyPlan(store, {
        left,
        right: 'dokploy://1/app/.env',
        keys: ['A'],
        expectedMtime: 0,
        receipt: (await compareGuarded(store, left, 'dokploy://1/app/.env', [])).receipt.id
      }),
      /cannot write|not writable/i
    )
    store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('apply: a receipt authorizes exactly the ordered pair it compared, never another pair with the same shapes', async () => {
  const { compareGuarded } = await import('./env')
  const dir = mkdtempSync(join(tmpdir(), 'drift-plan-bind-'))
  try {
    grantRoot(dir)
    const store = openStore(join(dir, 'plumbr.db'))
    // Four files, two identical shapes: A and C are one shape, B and D the other.
    const [a, b, c, d] = ['a.env', 'b.env', 'c.env', 'd.env'].map((n) => join(dir, n))
    writeFileSync(a, 'KEY=from-a\n')
    writeFileSync(c, 'KEY=from-a\n')
    writeFileSync(b, 'KEY=old\n')
    writeFileSync(d, 'KEY=old\n')
    const { receipt } = await compareGuarded(store, a, b, [])
    const id = receipt.id!
    const mtime = (p: string): number => statSync(p).mtimeMs

    // Same shapes, different files: the plan does not cover C → D.
    await assert.rejects(
      applyPlan(store, { left: c, right: d, keys: ['KEY'], expectedMtime: mtime(d), receipt: id }),
      /different pair/i
    )
    assert.equal(readFileSync(d, 'utf8'), 'KEY=old\n')
    // Apply is directional: the reverse of the compared pair is a different plan too.
    await assert.rejects(
      applyPlan(store, { left: b, right: a, keys: ['KEY'], expectedMtime: mtime(a), receipt: id }),
      /different pair/i
    )
    assert.equal(readFileSync(a, 'utf8'), 'KEY=from-a\n')
    // The pair it was made for still applies.
    const r = await applyPlan(store, {
      left: a,
      right: b,
      keys: ['KEY'],
      expectedMtime: mtime(b),
      receipt: id
    })
    assert.deepEqual(r.written, ['KEY'])
    assert.equal(readFileSync(b, 'utf8'), 'KEY=from-a\n')
    store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
