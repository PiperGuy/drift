import { sep, resolve } from 'node:path'
import type { ScanResult } from '@shared/channels'
import { dockerRef, isRemote, parseRef, scanRoot, sshRef } from './fs'

/**
 * Roots the user granted: local folders from the OS picker, or ssh://host/path
 * the user typed. Every file read or write in main must live under one of them.
 */
const granted = new Set<string>()

const norm = (root: string): string => {
  const r = parseRef(root)
  if (r.kind === 'local') return resolve(root)
  // `/` stays `/`; anything else loses trailing slashes.
  if (r.kind === 'ssh') return sshRef(r.host, r.path.replace(/\/+$/, '') || '/')
  if (r.kind === 'docker') return dockerRef(r.host, r.container, r.path.replace(/\/+$/, '') || '/')
  return root.replace(/\/+$/, '')
}

/**
 * Remote refs are handed verbatim to `cat`, `stat` and `find` on the other side
 * (ssh, docker exec, ECS Exec) or to a provider API, so a `.` or `..` segment
 * would let a forged renderer path escape the granted directory even though it
 * string-prefix-matches the root. Such refs are never granted and never pass
 * isGranted. Local paths are canonicalised by resolve() instead.
 */
export const traverses = (ref: string): boolean =>
  ref.split('/').some((seg) => seg === '.' || seg === '..')

export function grantRoot(root: string): void {
  if (isRemote(root) && traverses(root))
    throw new Error(`${root}: a root must not contain "." or ".." path segments`)
  granted.add(norm(root))
}
export function revokeRoot(root: string): void {
  granted.delete(norm(root))
}
export function revokeRoots(): void {
  granted.clear()
}

export function isGranted(ref: string): boolean {
  if (isRemote(ref) && traverses(ref)) return false
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
