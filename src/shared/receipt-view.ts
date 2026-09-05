/**
 * Pure view helpers for the receipt and plan tables: filter by status,
 * search by key name, sort. Operates on redacted rows only (key + class).
 */
import type { DriftRow, DriftStatus, SyncAction } from './drift'

/** Order used when sorting by status: things needing review first. */
export const STATUS_ORDER: DriftStatus[] = [
  'missing',
  'changed',
  'blank',
  'unknown',
  'extra',
  'same',
  'ignored'
]

export type RowSort = 'status' | 'key'

export type ReceiptView = {
  /** Empty set = show everything. */
  statuses: ReadonlySet<DriftStatus>
  query: string
  sort: RowSort
}

export const DEFAULT_VIEW: ReceiptView = { statuses: new Set(), query: '', sort: 'status' }

export function filterRows(rows: readonly DriftRow[], view: ReceiptView): DriftRow[] {
  const q = view.query.trim().toLowerCase()
  const out = rows.filter(
    (r) =>
      (view.statuses.size === 0 || view.statuses.has(r.status)) &&
      (q === '' || r.key.toLowerCase().includes(q))
  )
  if (view.sort === 'status') {
    out.sort(
      (a, b) =>
        STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) ||
        a.key.localeCompare(b.key)
    )
  }
  return out
}

export function filterPlan(actions: readonly SyncAction[], query: string): SyncAction[] {
  const q = query.trim().toLowerCase()
  return q === '' ? [...actions] : actions.filter((a) => a.key.toLowerCase().includes(q))
}

export function toggleStatus(set: ReadonlySet<DriftStatus>, status: DriftStatus): Set<DriftStatus> {
  const next = new Set(set)
  if (next.has(status)) next.delete(status)
  else next.add(status)
  return next
}
