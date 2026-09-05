import type { DriftStatus } from '@shared/drift'

/**
 * Every status has a colour, a glyph and a word, so it survives colour-blindness,
 * grayscale printing and screen readers alike.
 */
export const STATUS_META: Record<
  DriftStatus,
  { glyph: string; label: string; hint: string; tone: string }
> = {
  same: {
    glyph: '=',
    label: 'same',
    hint: 'Same fingerprint on both sides',
    tone: 'text-ok bg-ok-soft border-ok/30'
  },
  changed: {
    glyph: '≠',
    label: 'changed',
    hint: 'Present on both sides, fingerprints differ',
    tone: 'text-warn bg-warn-soft border-warn/30'
  },
  missing: {
    glyph: '−',
    label: 'missing',
    hint: 'In A, absent from B',
    tone: 'text-bad bg-bad-soft border-bad/30'
  },
  extra: {
    glyph: '+',
    label: 'extra',
    hint: 'In B only; never removed automatically',
    tone: 'text-warn bg-warn-soft border-warn/30'
  },
  blank: {
    glyph: '∅',
    label: 'blank',
    hint: 'Key present but empty on at least one side',
    tone: 'text-muted-foreground bg-muted border-border'
  },
  unknown: {
    glyph: '?',
    label: 'unknown',
    hint: 'Present on both sides; this provider returns the name only, so the value cannot be compared',
    tone: 'text-muted-foreground bg-muted border-border'
  },
  ignored: {
    glyph: '·',
    label: 'ignored',
    hint: 'Expected to differ per environment',
    tone: 'text-muted-foreground bg-transparent border-border'
  }
}
