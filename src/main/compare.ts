import type { ProjectCompareRequest, ProjectCompareResult, ProjectSide } from '@shared/channels'
import { pairFiles } from '@shared/pairing'
import { compareGuarded } from './env'
import type { Store } from './store'
import { grantRoot, isGranted, scanWorkspace } from './workspace'

/**
 * Cross-source comparison: two projects, from any two remembered sources,
 * scanned fresh, paired by relative environment-file identity and compared
 * pair by pair. Roots outside the active source are granted for the session
 * only if the user remembered them earlier (they are in the store); anything
 * else is refused before a single byte is read.
 */
export function ensureSourceRoot(store: Store, root: string): void {
  if (isGranted(root)) return
  if (!store.listAllRoots().some((r) => r.path === root))
    throw new Error(`${root} is not a source in this app. Add it as a source first.`)
  grantRoot(root)
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export async function compareProjects(
  store: Store,
  req: ProjectCompareRequest
): Promise<ProjectCompareResult> {
  const side = async (s: ProjectSide): Promise<import('@shared/channels').EnvFileInfo[]> => {
    ensureSourceRoot(store, s.root)
    const scan = await scanWorkspace(s.root)
    return scan.files.filter((f) => (f.project ?? null) === s.project)
  }
  const [l, r] = await Promise.all([side(req.left), side(req.right)])
  const pairing = pairFiles(l, r)
  const pairs: ProjectCompareResult['pairs'] = []
  // ponytail: sequential per pair so a provider is never hit with N parallel reads; batch if projects grow.
  for (const p of pairing.pairs) {
    try {
      const { receipt } = await compareGuarded(store, p.left.path, p.right.path, ['NODE_ENV'])
      pairs.push({ ...p, receipt, error: null })
    } catch (e) {
      pairs.push({ ...p, receipt: null, error: message(e) })
    }
  }
  store.logEvent(
    'compare',
    { left: req.left, right: req.right },
    {
      pairs: pairs.length,
      onlyLeft: pairing.onlyLeft.length,
      onlyRight: pairing.onlyRight.length,
      ambiguous: pairing.ambiguous.length
    }
  )
  return {
    left: { ...req.left, files: l.length },
    right: { ...req.right, files: r.length },
    pairs,
    onlyLeft: pairing.onlyLeft,
    onlyRight: pairing.onlyRight,
    ambiguous: pairing.ambiguous
  }
}
