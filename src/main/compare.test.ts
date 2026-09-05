import { test, vi } from 'vitest'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDir } from './providers/testkit'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from('sealed:' + s),
    decryptString: (b: Buffer) => b.toString().slice(7)
  },
  app: { getVersion: () => '0.0.0-test' }
}))

const { openStore } = await import('./store')
const { grantRoot, isGranted, revokeRoots } = await import('./workspace')
const { compareProjects } = await import('./compare')

const dir = tempDir('drift-compare-')
const a = join(dir, 'a')
const b = join(dir, 'b')
mkdirSync(join(a, 'api', '.git'), { recursive: true })
mkdirSync(join(b, 'svc', '.git'), { recursive: true })
writeFileSync(join(a, 'api', '.env'), 'A=1\n')
writeFileSync(join(a, 'api', '.env.production'), 'DATABASE_URL=x\nONLY_A=1\n')
writeFileSync(join(b, 'svc', '.env.production'), 'DATABASE_URL=y\nONLY_B=1\n')
writeFileSync(join(b, 'svc', '.env.preview'), 'P=1\n')

test('compareProjects pairs by identity across two sources and stores a guarded receipt per pair', async () => {
  const store = openStore(join(dir, 'plumbr.db'))
  // Source A is the active workspace; source B lives in another workspace and is only remembered.
  store.rememberRoot(a, 'laptop')
  const other = store.createWorkspace('other')
  store.setActiveWorkspace(other.id)
  store.rememberRoot(b, 'server')
  store.setActiveWorkspace(1)
  revokeRoots()
  grantRoot(a)
  assert.equal(isGranted(b), false)

  const r = await compareProjects(store, {
    left: { root: a, project: 'api' },
    right: { root: b, project: 'svc' }
  })
  // The remembered-but-inactive root was granted for this session, nothing else.
  assert.equal(isGranted(b), true)
  assert.deepEqual(r.left, { root: a, project: 'api', files: 2 })
  assert.deepEqual(r.right, { root: b, project: 'svc', files: 2 })
  assert.deepEqual(
    r.pairs.map((p) => [p.id, p.left.rel, p.right.rel, p.error]),
    [['.env.production', 'api/.env.production', 'svc/.env.production', null]]
  )
  const receipt = r.pairs[0].receipt!
  assert.equal(typeof receipt.id, 'number')
  assert.equal(receipt.counts.changed, 1)
  assert.equal(receipt.counts.missing, 1)
  assert.equal(receipt.counts.extra, 1)
  assert.deepEqual(
    r.onlyLeft.map((f) => f.rel),
    ['api/.env']
  )
  assert.deepEqual(
    r.onlyRight.map((f) => f.rel),
    ['svc/.env.preview']
  )
  // The stored receipt is bound to the exact ordered refs it compared, with an opaque guard
  // (no key names, no values).
  const guard = store.receiptGuard(receipt.id!)
  assert.ok(guard)
  assert.equal(guard.left, join(a, 'api', '.env.production'))
  assert.equal(guard.right, join(b, 'svc', '.env.production'))
  assert.ok(guard.guard.length >= 32)
  assert.ok(!guard.guard.includes('DATABASE_URL'))
  assert.ok(!JSON.stringify(store.listEvents()).includes('=x'))

  // A root nobody granted is refused, even if it exists on disk.
  const stranger = join(dir, 'stranger')
  mkdirSync(stranger, { recursive: true })
  await assert.rejects(
    compareProjects(store, {
      left: { root: a, project: 'api' },
      right: { root: stranger, project: null }
    }),
    /not a source/i
  )
  store.close()
})
