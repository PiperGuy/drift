import { ProviderError } from './http'

/**
 * Shared discipline for provider writes. Values exist here only for the
 * duration of one call and never appear in an error or a log: messages carry
 * key names, counts and the provider's own short message.
 */

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * Apply entries one at a time, in order, with no retry. A failure part-way
 * names what already landed so the user knows the target is now mixed.
 */
export async function applyEach(
  entries: { key: string; value: string }[],
  one: (entry: { key: string; value: string }) => Promise<void>
): Promise<string[]> {
  const written: string[] = []
  for (const entry of entries) {
    try {
      await one(entry)
    } catch (e) {
      const kind = e instanceof ProviderError ? e.kind : 'http'
      throw new ProviderError(
        kind,
        `${written.length ? `Wrote ${written.join(', ')}, then failed` : 'Failed'} on ${entry.key}: ${msg(e)} Nothing was retried; compare again to see the current state.`
      )
    }
    written.push(entry.key)
  }
  return written
}

/** Compare read-back values with what was written. Returns the keys that did not confirm. */
export function unconfirmed(
  entries: { key: string; value: string }[],
  readBack: (key: string) => string | null | undefined
): string[] {
  return entries.filter((e) => readBack(e.key) !== e.value).map((e) => e.key)
}

/** One truthful line for the result: what the read-back confirmed plus any deployment effect. */
export function verdict(
  entries: { key: string; value: string }[],
  missing: string[],
  effect: string
): { verified: boolean; note: string } {
  if (missing.length === 0)
    return {
      verified: true,
      note: `${entries.length} value${entries.length === 1 ? '' : 's'} confirmed by read-back. ${effect}`
    }
  return {
    verified: false,
    note: `Read-back did not confirm ${missing.join(', ')}: the provider accepted the write but returned something else. Check it in the provider before relying on it. ${effect}`
  }
}
