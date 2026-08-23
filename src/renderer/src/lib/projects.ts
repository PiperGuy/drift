import { useMemo } from 'react'
import type { EnvFileInfo } from '@shared/channels'
import type { EnvKind } from '@shared/env-file'
import { UNGROUPED, projectKey, useWorkspace } from '@/store/workspace'

export const KIND_LABEL: Record<EnvKind, string> = {
  base: '.env',
  local: 'local',
  development: 'development',
  staging: 'staging',
  preview: 'preview',
  production: 'production',
  example: 'example',
  other: 'other'
}
/** One tint per environment so production reads as production at a glance. */
export const KIND_TONE: Record<EnvKind, string> = {
  base: 'bg-ok-soft text-ok border-ok/20',
  local: 'bg-ok-soft text-ok border-ok/20',
  development: 'bg-ok-soft text-ok border-ok/20',
  staging: 'bg-warn-soft text-warn border-warn/20',
  preview: 'bg-lemon-soft text-lemon-ink border-lemon-ink/20',
  production: 'bg-bad-soft text-bad border-bad/20',
  example: 'bg-muted text-muted-foreground border-border',
  other: 'bg-muted text-muted-foreground border-border'
}

export type Group = { key: string; root: string; name: string; fs: EnvFileInfo[] }

/** Does a file match the workspace search: path, or a key name once the project was inspected. */
export function useFileMatch(): (f: EnvFileInfo) => boolean {
  const q = useWorkspace((s) => s.search)
    .trim()
    .toLowerCase()
  const summaries = useWorkspace((s) => s.summaries)
  return (f) =>
    !q ||
    f.rel.toLowerCase().includes(q) ||
    (summaries[f.path]?.names.some((k) => k.key.toLowerCase().includes(q)) ?? false)
}

export function useGroups(): Group[] {
  const scan = useWorkspace((s) => s.scan)
  const roots = useWorkspace((s) => s.roots)
  return useMemo<Group[]>(() => {
    const m = new Map<string, Group>()
    for (const f of scan?.files ?? []) {
      const key = projectKey(f)
      const g = m.get(key) ?? { key, root: f.root, name: f.project ?? UNGROUPED, fs: [] }
      g.fs.push(f)
      m.set(key, g)
    }
    const order = new Map(roots.map((r, i) => [r.path, i]))
    return [...m.values()].sort(
      (a, b) =>
        (order.get(a.root) ?? 0) - (order.get(b.root) ?? 0) ||
        (a.name === UNGROUPED ? 1 : b.name === UNGROUPED ? -1 : a.name.localeCompare(b.name))
    )
  }, [scan, roots])
}
