import { sep, resolve } from 'node:path'
import type { ScanResult } from '@shared/channels'
import { isRemote, parseRef, scanRoot, sshRef } from './fs'

/**
 * Roots the user granted: local folders from the OS picker, or ssh://host/path
 * the user typed. Every file read or write in main must live under one of them.
 */
const granted = new Set<string>()

const norm = (root: string): string => {
  if (!isRemote(root)) return resolve(root)
  const r = parseRef(root)
  if (r.kind === 'vault') return root.replace(/\/+$/, '')
  const s = r as { host: string; path: string }
  // `/` stays `/`; anything else loses trailing slashes.
  return sshRef(s.host, s.path.replace(/\/+$/, '') || '/')
}

export function grantRoot(root: string): void {
  granted.add(norm(root))
}
export function revokeRoot(root: string): void {
  granted.delete(norm(root))
}
export function revokeRoots(): void {
  granted.clear()
}

export function isGranted(ref: string): boolean {
  const p = isRemote(ref) ? ref : resolve(ref)
  for (const root of granted) {
    if (p === root) return true
    if (isRemote(root)) {
      if (p.startsWith(root.endsWith('/') ? root : root + '/')) return true
    } else if (p.startsWith(root + sep)) return true
  }
  return false
}

export function assertGranted(ref: string): void {
  if (!isGranted(ref)) throw new Error('Path is outside every granted workspace root')
}

/** Every .env* under the root with metadata only, grouped by nearest Git repository. */
export async function scanWorkspace(root: string): Promise<ScanResult> {
  assertGranted(root)
  return scanRoot(norm(root))
}
