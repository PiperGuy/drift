/**
 * Pure, deterministic drift classification used by the receipt, the MCP
 * example, and the sync-plan stepper. Works on redacted shapes only: a key
 * name plus a synthetic fingerprint of the value. No raw values ever enter
 * this module.
 */

export type KeyEntry = {
  key: string
  /**
   * Synthetic fingerprint of the value. `null` means the key is present but blank;
   * OPAQUE_FINGERPRINT means the provider reports the key by name only.
   */
  fingerprint: string | null
}

/**
 * Some providers never return a value (GitHub secrets, Vercel sensitive vars, ECS
 * `secrets`). Their adapters render the key with this stand-in text for the
 * viewer and report the key in the read's `opaque` metadata; envShape turns THAT
 * into OPAQUE_FINGERPRINT and a write never copies it. The text itself decides
 * nothing: a real value equal to it is an ordinary value.
 */
export const OPAQUE_VALUE = '<value not readable from this provider>'
export const OPAQUE_FINGERPRINT = '?'

export type DriftStatus = 'same' | 'changed' | 'missing' | 'extra' | 'blank' | 'unknown' | 'ignored'

export type DriftRow = { key: string; status: DriftStatus }

export type DriftReceipt = {
  /** Set by main once stored: the plan id an apply must quote so main can check nothing moved since. */
  id?: number
  left: string
  right: string
  rows: DriftRow[]
  counts: Record<DriftStatus, number>
  /** True when nothing needs review before deploying `left` config to `right`. */
  clean: boolean
}

const EMPTY_COUNTS: Record<DriftStatus, number> = {
  same: 0,
  changed: 0,
  missing: 0,
  extra: 0,
  blank: 0,
  unknown: 0,
  ignored: 0
}

/**
 * Compare two redacted key sets. `missing` = present in left, absent in right.
 * `extra` = present in right, absent in left. Output is sorted by key so
 * receipts are stable across runs.
 */
export function compareEnv(
  left: { name: string; entries: KeyEntry[] },
  right: { name: string; entries: KeyEntry[] },
  ignore: readonly string[] = []
): DriftReceipt {
  const l = new Map(left.entries.map((e) => [e.key, e.fingerprint]))
  const r = new Map(right.entries.map((e) => [e.key, e.fingerprint]))
  const ignored = new Set(ignore)
  const keys = [...new Set([...l.keys(), ...r.keys()])].sort()

  const rows: DriftRow[] = keys.map((key) => {
    if (ignored.has(key)) return { key, status: 'ignored' }
    const inL = l.has(key)
    const inR = r.has(key)
    if (inL && !inR) return { key, status: 'missing' }
    if (!inL && inR) return { key, status: 'extra' }
    const a = l.get(key) ?? null
    const b = r.get(key) ?? null
    if (a === null || b === null) return { key, status: 'blank' }
    // Presence is known on both sides, the value is not: neither same nor changed.
    if (a === OPAQUE_FINGERPRINT || b === OPAQUE_FINGERPRINT) return { key, status: 'unknown' }
    return { key, status: a === b ? 'same' : 'changed' }
  })

  const counts = { ...EMPTY_COUNTS }
  for (const row of rows) counts[row.status] += 1

  const clean = counts.changed + counts.missing + counts.extra + counts.blank + counts.unknown === 0

  return { left: left.name, right: right.name, rows, counts, clean }
}

export type SyncAction = {
  key: string
  /** What a human-approved sync would do to the target for this key. */
  op: 'add' | 'update' | 'keep' | 'review'
  reason: string
}

/**
 * Turn a receipt into a dry-run plan from `left` (source) to `right` (target).
 * The plan is descriptive only: nothing here writes anywhere. Extra keys on the
 * target are never removed automatically; they are surfaced for review.
 */
export function planSync(receipt: DriftReceipt): SyncAction[] {
  const actions: SyncAction[] = []
  for (const { key, status } of receipt.rows) {
    switch (status) {
      case 'missing':
        actions.push({ key, op: 'add', reason: `absent in ${receipt.right}` })
        break
      case 'changed':
        actions.push({ key, op: 'update', reason: 'fingerprint differs' })
        break
      case 'blank':
        actions.push({ key, op: 'review', reason: 'blank on one side' })
        break
      case 'unknown':
        actions.push({ key, op: 'review', reason: 'value not readable on one side' })
        break
      case 'extra':
        actions.push({
          key,
          op: 'keep',
          reason: `only in ${receipt.right}; never removed automatically`
        })
        break
      case 'same':
      case 'ignored':
        break
    }
  }
  return actions
}

export type McpMismatchContext = {
  left: string
  right: string
  missing: string[]
  extra: string[]
  changed: string[]
  blank: string[]
  /** Present on both sides, but one provider returns names only. */
  unknown: string[]
  values: 'redacted'
}

/** The only shape an MCP client ever sees: key names and classifications. */
export function toMcpContext(receipt: DriftReceipt): McpMismatchContext {
  const pick = (s: DriftStatus): string[] =>
    receipt.rows.filter((r) => r.status === s).map((r) => r.key)
  return {
    left: receipt.left,
    right: receipt.right,
    missing: pick('missing'),
    extra: pick('extra'),
    changed: pick('changed'),
    blank: pick('blank'),
    unknown: pick('unknown'),
    values: 'redacted'
  }
}
