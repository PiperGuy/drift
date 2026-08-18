/**
 * Minimal, dependency-free .env parser. Pure: it never touches the file
 * system and never logs. Raw values only exist between parse and redaction,
 * which both happen in the main process.
 */
export type RawEntry = { key: string; value: string }

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)?\s*$/

export function parseEnv(text: string): RawEntry[] {
  const out: RawEntry[] = []
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim() || line.trim().startsWith('#')) continue
    const m = LINE.exec(line)
    if (!m) continue
    const key = m[1]
    let value = (m[2] ?? '').trim()
    // Multi-line double-quoted values.
    if (value.startsWith('"') && !value.slice(1).includes('"')) {
      while (i + 1 < lines.length && !value.slice(1).includes('"')) {
        i += 1
        value += '\n' + lines[i]
      }
    }
    if (value.startsWith('"') || value.startsWith("'") || value.startsWith('`')) {
      const q = value[0]
      const end = value.indexOf(q, 1)
      value = end > 0 ? value.slice(1, end) : value.slice(1)
      if (q === '"') value = value.replace(/\\n/g, '\n').replace(/\\"/g, '"')
    } else {
      // Unquoted: strip trailing comment.
      value = value.replace(/\s+#.*$/, '').trim()
    }
    out.push({ key, value })
  }
  return out
}

/** File names that count as environment files during discovery. */
export const ENV_FILE = /^\.env(\..+)?$/
/** Directories never walked. */
export const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  'build',
  '.next',
  'target',
  'vendor',
  '.venv',
  '__pycache__'
])
