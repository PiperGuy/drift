import { readdir, stat } from 'node:fs/promises'
import { join, relative, sep, resolve } from 'node:path'
import { ENV_FILE, SKIP_DIRS } from '@shared/env-file'
import type { EnvFileInfo, ScanResult } from '@shared/channels'

/**
 * Roots the user granted through the OS folder picker. Every file read in
 * main must live under one of these. Nothing outside is ever opened.
 */
const granted = new Set<string>()

export function grantRoot(root: string): void {
  granted.add(resolve(root))
}

export function isGranted(path: string): boolean {
  const p = resolve(path)
  for (const root of granted) if (p === root || p.startsWith(root + sep)) return true
  return false
}

export function assertGranted(path: string): void {
  if (!isGranted(path)) throw new Error('Path is outside every granted workspace root')
}

/**
 * Walk the root, collect every .env* with metadata only, and group each file
 * by the nearest ancestor directory that contains `.git`. Files are never
 * opened here.
 */
export async function scanWorkspace(root: string): Promise<ScanResult> {
  assertGranted(root)
  const started = performance.now()
  const files: EnvFileInfo[] = []
  let scannedDirs = 0

  // ponytail: sequential recursive walk. Swap for a bounded worker pool if roots with 100k+ dirs feel slow.
  async function walk(dir: string, project: string | null): Promise<void> {
    scannedDirs += 1
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    const isRepo = entries.some((e) => e.name === '.git')
    const here = isRepo ? relative(root, dir) || '.' : project
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue
        await walk(full, here)
      } else if (e.isFile() && ENV_FILE.test(e.name)) {
        try {
          const s = await stat(full)
          files.push({
            path: full,
            rel: relative(root, full),
            name: e.name,
            project: here,
            modifiedAt: s.mtimeMs,
            size: s.size
          })
        } catch {
          /* vanished between readdir and stat */
        }
      }
    }
  }

  await walk(resolve(root), null)
  files.sort((a, b) => a.rel.localeCompare(b.rel))
  const projects = [
    ...new Set(files.map((f) => f.project).filter((p): p is string => p !== null))
  ].sort()
  return { root, files, projects, scannedDirs, durationMs: Math.round(performance.now() - started) }
}
