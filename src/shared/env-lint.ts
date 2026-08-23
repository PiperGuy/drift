/**
 * Lint, format and redacted-render for .env files. Pure functions over text.
 * `viewEnv` is what the renderer gets: every line typed, values replaced by a
 * mask of the same length class. Raw values never leave this module's caller.
 */
import { assignmentSpans } from './env-file'

const LINE = /^(\s*)(export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)(\s*)=(\s*)(.*)$/

export type LintRule =
  | 'duplicate-key'
  | 'invalid-line'
  | 'unquoted-space'
  | 'unquoted-hash'
  | 'surrounding-space'
  | 'key-case'
  | 'trailing-whitespace'
  | 'empty-value'
  | 'no-final-newline'
  | 'crlf'
  | 'secret-in-example'
  | 'mixed-export'

export type Severity = 'error' | 'warning' | 'info'
export type LintIssue = {
  line: number
  rule: LintRule
  severity: Severity
  message: string
  fixable: boolean
}

export type ViewLine =
  | { n: number; kind: 'blank' }
  | { n: number; kind: 'comment'; text: string }
  | { n: number; kind: 'invalid'; text: string }
  | {
      n: number
      kind: 'assign'
      key: string
      export: boolean
      quote: '"' | "'" | '`' | null
      /** Value length in characters (0 = blank). */
      length: number
      multiline: boolean
      /** Trailing `# comment` on an unquoted value, shown as-is. */
      comment: string | null
      /** Mask the renderer prints instead of the value. */
      mask: string
      /** Later assignment of the same key exists: this one is shadowed. */
      shadowed: boolean
    }

export type EnvView = { lines: ViewLine[]; lint: LintIssue[]; formatted: boolean }

const SECRET_KEY = /(SECRET|TOKEN|PASS(WORD)?|PRIVATE|API_?KEY|ACCESS_?KEY|CREDENTIAL|AUTH)/i

/** Looks like a real credential rather than a placeholder: long, mixed classes, no spaces. */
export function looksLikeSecret(value: string): boolean {
  if (value.length < 20 || /\s/.test(value)) return false
  if (/^(your|xxx|changeme|replace|todo|example|placeholder|<)/i.test(value)) return false
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(value)).length
  return classes >= 3 || (classes >= 2 && value.length >= 32)
}

function splitUnquoted(v: string): { value: string; comment: string | null } {
  const m = /^(.*?)\s+#(.*)$/.exec(v)
  return m ? { value: m[1], comment: '#' + m[2] } : { value: v, comment: null }
}

export function lintEnv(text: string, opts: { example?: boolean } = {}): LintIssue[] {
  const issues: LintIssue[] = []
  const lines = text.split('\n')
  if (text.includes('\r'))
    issues.push({
      line: 1,
      rule: 'crlf',
      severity: 'info',
      message: 'Windows line endings',
      fixable: true
    })
  if (text.length && !text.endsWith('\n'))
    issues.push({
      line: lines.length,
      rule: 'no-final-newline',
      severity: 'info',
      message: 'No newline at end of file',
      fixable: true
    })

  const spans = assignmentSpans(text)
  const lastByKey = new Map<string, number>()
  for (const s of spans) lastByKey.set(s.key, s.start)
  let sawExport = false
  let sawPlain = false

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].replace(/\r$/, '')
    const n = i + 1
    if (/[ \t]+$/.test(raw))
      issues.push({
        line: n,
        rule: 'trailing-whitespace',
        severity: 'info',
        message: 'Trailing whitespace',
        fixable: true
      })
    if (!raw.trim() || raw.trim().startsWith('#')) continue
    const m = LINE.exec(raw)
    if (!m) {
      issues.push({
        line: n,
        rule: 'invalid-line',
        severity: 'error',
        message: 'Not a KEY=value assignment',
        fixable: false
      })
      continue
    }
    const [, , exp, key, sp1, sp2, rest] = m
    if (exp) sawExport = true
    else sawPlain = true
    if (
      lastByKey.get(key) !== undefined &&
      lastByKey.get(key) !== i &&
      spans.some((s) => s.start === i)
    )
      issues.push({
        line: n,
        rule: 'duplicate-key',
        severity: 'warning',
        message: `${key} is assigned again later; this value is ignored`,
        fixable: false
      })
    if (!/^[A-Z][A-Z0-9_]*$/.test(key))
      issues.push({
        line: n,
        rule: 'key-case',
        severity: 'info',
        message: 'Keys are conventionally UPPER_SNAKE_CASE',
        fixable: false
      })
    if (sp1 || sp2)
      issues.push({
        line: n,
        rule: 'surrounding-space',
        severity: 'info',
        message: 'Spaces around =',
        fixable: true
      })
    const v = rest.trim()
    const quoted = /^["'`]/.test(v)
    if (!quoted) {
      const { value } = splitUnquoted(v)
      if (value === '')
        issues.push({
          line: n,
          rule: 'empty-value',
          severity: 'warning',
          message: `${key} is blank`,
          fixable: false
        })
      if (/\s/.test(value))
        issues.push({
          line: n,
          rule: 'unquoted-space',
          severity: 'warning',
          message: 'Unquoted value contains whitespace; quote it',
          fixable: true
        })
      if (/#/.test(value))
        issues.push({
          line: n,
          rule: 'unquoted-hash',
          severity: 'warning',
          message: 'Unquoted # may start a comment in other loaders; quote it',
          fixable: true
        })
      if (opts.example && looksLikeSecret(value) && SECRET_KEY.test(key))
        issues.push({
          line: n,
          rule: 'secret-in-example',
          severity: 'error',
          message: 'Looks like a real credential in an example file',
          fixable: false
        })
    } else if (v.length === 2 && v[0] === v[1]) {
      issues.push({
        line: n,
        rule: 'empty-value',
        severity: 'warning',
        message: `${key} is blank`,
        fixable: false
      })
    }
    // Skip continuation lines of a multi-line quoted value.
    const span = spans.find((s) => s.start === i)
    if (span) i = span.end
  }
  if (sawExport && sawPlain)
    issues.push({
      line: 1,
      rule: 'mixed-export',
      severity: 'info',
      message: 'Mixes `export KEY=` and `KEY=`',
      fixable: false
    })
  return issues.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule))
}

/** Quote a value only if it needs it; double quotes, escaping " and newlines. */
function quoteIfNeeded(value: string): string {
  if (value === '') return ''
  if (/[\s#"'`\\]/.test(value) || value !== value.trim()) {
    return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"'
  }
  return value
}

/**
 * Canonical form: `KEY=value`, no spaces around =, values quoted only when needed,
 * trailing whitespace gone, at most one blank line in a row, LF endings, final
 * newline. Comments, order, `export` prefixes and duplicate keys are preserved:
 * the formatter never changes meaning, only spelling.
 */
export function formatEnv(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  const spans = assignmentSpans(text)
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].replace(/[ \t]+$/, '')
    if (!raw.trim()) {
      if (out.length && out[out.length - 1] !== '') out.push('')
      continue
    }
    if (raw.trim().startsWith('#')) {
      out.push(raw.trim())
      continue
    }
    const m = LINE.exec(raw)
    const span = spans.find((s) => s.start === i)
    if (!m || !span) {
      out.push(raw)
      continue
    }
    const [, , exp, key, , , rest] = m
    const v = rest.trim()
    let value: string
    let comment: string | null = null
    if (v.startsWith('"')) {
      // Re-parse the (possibly multi-line) quoted value from the span, then re-quote.
      const body = span.text.replace(/^\s*(export\s+)?[^=]+=\s*/, '')
      const end = body.indexOf('"', 1)
      value = (end > 0 ? body.slice(1, end) : body.slice(1))
        .replace(/\\n/g, '\n')
        .replace(/\\"/g, '"')
      i = span.end
    } else if (v.startsWith("'") || v.startsWith('`')) {
      const end = v.indexOf(v[0], 1)
      value = end > 0 ? v.slice(1, end) : v.slice(1)
    } else {
      const s = splitUnquoted(v)
      value = s.value
      comment = s.comment
    }
    out.push(`${exp ? 'export ' : ''}${key}=${quoteIfNeeded(value)}${comment ? ' ' + comment : ''}`)
  }
  while (out.length && out[out.length - 1] === '') out.pop()
  return out.length ? out.join('\n') + '\n' : ''
}

/** Redacted rendering for the renderer. No value, no fragment of a value, leaves here. */
export function viewEnv(text: string, opts: { example?: boolean } = {}): EnvView {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  const spans = assignmentSpans(text)
  const last = new Map<string, number>()
  for (const s of spans) last.set(s.key, s.start)
  const out: ViewLine[] = []
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const n = i + 1
    if (!raw.trim()) {
      out.push({ n, kind: 'blank' })
      continue
    }
    if (raw.trim().startsWith('#')) {
      out.push({ n, kind: 'comment', text: raw })
      continue
    }
    const m = LINE.exec(raw)
    const span = spans.find((s) => s.start === i)
    if (!m || !span) {
      // Not parseable: show the first token only, never what follows it.
      out.push({
        n,
        kind: 'invalid',
        text: raw.trim().split(/\s+/)[0].slice(0, 40) + (raw.trim().length > 40 ? '…' : '')
      })
      continue
    }
    const [, , exp, key, , , rest] = m
    const v = rest.trim()
    const quote = (/^["'`]/.test(v) ? v[0] : null) as ViewLine extends { quote: infer Q }
      ? Q
      : never
    let length: number
    let comment: string | null = null
    if (quote === '"') {
      const body = span.text.replace(/^\s*(export\s+)?[^=]+=\s*/, '')
      const end = body.indexOf('"', 1)
      length = (end > 0 ? body.slice(1, end) : body.slice(1)).length
    } else if (quote) {
      const end = v.indexOf(quote, 1)
      length = (end > 0 ? v.slice(1, end) : v.slice(1)).length
    } else {
      const s = splitUnquoted(v)
      length = s.value.length
      comment = s.comment
    }
    out.push({
      n,
      kind: 'assign',
      key,
      export: Boolean(exp),
      quote,
      length,
      multiline: span.end > span.start,
      comment,
      mask: length === 0 ? '' : '•'.repeat(Math.min(length, 24)) + (length > 24 ? '…' : ''),
      shadowed: last.get(key) !== i
    })
    i = span.end
  }
  return { lines: out, lint: lintEnv(text, opts), formatted: formatEnv(text) === text }
}
