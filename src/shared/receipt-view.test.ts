import { test } from 'vitest'
import assert from 'node:assert/strict'
import type { DriftRow } from './drift'
import { DEFAULT_VIEW, filterPlan, filterRows, toggleStatus } from './receipt-view'
import { envKind } from './env-file'

const rows: DriftRow[] = [
  { key: 'A_SAME', status: 'same' },
  { key: 'B_MISSING', status: 'missing' },
  { key: 'C_CHANGED', status: 'changed' },
  { key: 'D_EXTRA', status: 'extra' },
  { key: 'E_BLANK', status: 'blank' },
  { key: 'F_IGNORED', status: 'ignored' }
]

test('default view sorts review items first, then by key', () => {
  assert.deepEqual(
    filterRows(rows, DEFAULT_VIEW).map((r) => r.key),
    ['B_MISSING', 'C_CHANGED', 'E_BLANK', 'D_EXTRA', 'A_SAME', 'F_IGNORED']
  )
})

test('key sort keeps receipt order; status filter and search narrow', () => {
  assert.deepEqual(
    filterRows(rows, { ...DEFAULT_VIEW, sort: 'key' }).map((r) => r.key),
    rows.map((r) => r.key)
  )
  const statuses = toggleStatus(toggleStatus(new Set(), 'missing'), 'extra')
  assert.deepEqual(
    filterRows(rows, { ...DEFAULT_VIEW, statuses }).map((r) => r.key),
    ['B_MISSING', 'D_EXTRA']
  )
  assert.deepEqual(
    filterRows(rows, { ...DEFAULT_VIEW, query: '  chan ' }).map((r) => r.key),
    ['C_CHANGED']
  )
  assert.equal(toggleStatus(statuses, 'missing').has('missing'), false)
})

test('filterPlan searches by key, case-insensitive', () => {
  const plan = [
    { key: 'REDIS_URL', op: 'keep' as const, reason: 'r' },
    { key: 'STRIPE_KEY', op: 'update' as const, reason: 'r' }
  ]
  assert.deepEqual(
    filterPlan(plan, 'redis').map((a) => a.key),
    ['REDIS_URL']
  )
  assert.equal(filterPlan(plan, '').length, 2)
})

test('envKind classifies by file name only', () => {
  assert.equal(envKind('.env'), 'base')
  assert.equal(envKind('.env.local'), 'local')
  assert.equal(envKind('.env.production.local'), 'local')
  assert.equal(envKind('.env.staging'), 'staging')
  assert.equal(envKind('.env.Production'), 'production')
  assert.equal(envKind('.env.preview'), 'preview')
  assert.equal(envKind('.env.development'), 'development')
  assert.equal(envKind('.env.example'), 'example')
  assert.equal(envKind('.env.ci'), 'other')
})
