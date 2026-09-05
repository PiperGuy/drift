import { OPAQUE_VALUE } from '@shared/drift'
import { quoteIfNeeded } from '@shared/env-lint'
import type { EnvRead } from '../fs'

export const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_.-]*$/

/** A key as a provider reports it: with its value, or by name only (`value: null`). */
export type Entry = { key: string; value: string | null }

/**
 * Canonical `.env` text for a provider's key set, so the existing redaction,
 * viewer, receipt and reveal paths work unchanged. Header lines become comments.
 * Names-only keys render with the OPAQUE_VALUE placeholder for the viewer AND
 * are returned in `opaque`; envShape and applyPlan act on that set only, so a
 * real value that happens to equal the placeholder text is never mistaken for
 * one. Keys that are not valid env names are counted, not rendered.
 */
export function renderEnv(header: string[], entries: Entry[]): EnvRead {
  const opaque = new Set(
    entries.filter((e) => e.value === null && ENV_KEY.test(e.key)).map((e) => e.key)
  )
  return { text: renderEntries(header, entries), opaque }
}

export function renderEntries(header: string[], entries: Entry[]): string {
  const lines = header.map((h) => `# ${h}`)
  let hidden = 0
  let opaque = 0
  for (const { key, value } of entries) {
    if (!ENV_KEY.test(key)) {
      hidden += 1
      continue
    }
    if (value === null) opaque += 1
    lines.push(`${key}=${quoteIfNeeded(value ?? OPAQUE_VALUE)}`)
  }
  if (opaque > 0)
    lines.push(
      `# ${opaque} key${opaque === 1 ? '' : 's'} reported by name only: this provider never returns the value (compared as "unknown")`
    )
  if (hidden > 0)
    lines.push(`# ${hidden} key${hidden === 1 ? '' : 's'} not shown (not a valid env name)`)
  return lines.join('\n') + '\n'
}
