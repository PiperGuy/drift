import type { EnvFileInfo } from './channels'

/**
 * Cross-source pairing: which environment file on side A corresponds to which
 * on side B. Pure and deterministic; the identity is the file's path inside
 * its project directory, so `apps/api/.env.production` in a folder pairs with
 * Vercel's `.env.production` and Railway's `web/.env.production` (service
 * `web`). Nothing is paired by guesswork: an identity present more than once
 * on one side is reported as ambiguous instead of matched to something.
 */

/**
 * `rel` with the longest run of leading segments that is a suffix of `project`
 * removed. Provider "projects" are labels (`acme/api`, `site`) that never
 * prefix the path, so those files keep their full relative path.
 */
export function envIdentity(rel: string, project: string | null): string {
  if (!project || project === '.') return rel
  const p = project.split('/')
  const r = rel.split('/')
  for (let n = Math.min(p.length, r.length - 1); n > 0; n--) {
    if (p.slice(-n).join('/') === r.slice(0, n).join('/')) return r.slice(n).join('/')
  }
  return rel
}

export type FilePair = { id: string; left: EnvFileInfo; right: EnvFileInfo }
export type Pairing = {
  pairs: FilePair[]
  onlyLeft: EnvFileInfo[]
  onlyRight: EnvFileInfo[]
  /** Files whose identity is shared with another file on the same side. Never paired. */
  ambiguous: EnvFileInfo[]
}

const byId = (files: EnvFileInfo[]): Map<string, EnvFileInfo[]> => {
  const m = new Map<string, EnvFileInfo[]>()
  for (const f of files) {
    const id = envIdentity(f.rel, f.project)
    m.set(id, [...(m.get(id) ?? []), f])
  }
  return m
}
const byRel = (a: EnvFileInfo, b: EnvFileInfo): number => a.rel.localeCompare(b.rel)

export function pairFiles(left: EnvFileInfo[], right: EnvFileInfo[]): Pairing {
  const l = byId(left)
  const r = byId(right)
  const out: Pairing = { pairs: [], onlyLeft: [], onlyRight: [], ambiguous: [] }
  for (const [id, ls] of l) {
    const rs = r.get(id) ?? []
    if (ls.length > 1 || rs.length > 1) out.ambiguous.push(...ls, ...rs)
    else if (rs.length === 1) out.pairs.push({ id, left: ls[0], right: rs[0] })
    else out.onlyLeft.push(ls[0])
  }
  for (const [id, rs] of r) if (!l.has(id)) out.onlyRight.push(...rs)
  out.pairs.sort((a, b) => a.id.localeCompare(b.id))
  out.onlyLeft.sort(byRel)
  out.onlyRight.sort(byRel)
  out.ambiguous.sort(byRel)
  return out
}
