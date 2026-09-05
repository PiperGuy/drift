import { useEffect, useState, type CSSProperties } from 'react'
import { ArrowRight, ArrowRightLeft, RefreshCw } from 'lucide-react'
import type { PairReceipt, ProjectSide, SourceRoot } from '@shared/channels'
import { SourceIcon } from '@/components/app/SourceIcon'
import { Button } from '@/components/ui/button'
import { UNGROUPED, useWorkspace } from '@/store/workspace'
import { fromOption, toOption } from '@/lib/projects'
import { cn } from '@/lib/utils'

/** One side: pick a source root, then a project inside it (scanned fresh, metadata only). */
function SidePicker({
  side,
  value,
  onChange
}: {
  side: 'A' | 'B'
  value: ProjectSide | null
  onChange: (s: ProjectSide | null) => void
}): React.JSX.Element {
  const allRoots = useWorkspace((s) => s.allRoots)
  // The scan result is keyed by the root it came from, so a change of root reads as "scanning".
  const [scanned, setScanned] = useState<{
    root: string
    projects: (string | null)[] | null
    error: string | null
  } | null>(null)
  const root = value?.root ?? ''
  useEffect(() => {
    if (!root) return
    let live = true
    window.plumbr
      .scanWorkspace({ root })
      .then((scan) => {
        if (!live) return
        const seen = [...new Set(scan.files.map((f) => f.project))]
        setScanned({
          root,
          projects: seen.sort((a, b) => (a ?? '~').localeCompare(b ?? '~')),
          error: null
        })
      })
      .catch(
        (e) =>
          live &&
          setScanned({ root, projects: null, error: e instanceof Error ? e.message : String(e) })
      )
    return () => {
      live = false
    }
  }, [root])
  const projects = scanned?.root === root ? scanned.projects : null
  const error = scanned?.root === root ? scanned.error : null
  const byWorkspace = new Map<string, SourceRoot[]>()
  for (const r of allRoots)
    byWorkspace.set(r.workspaceName, [...(byWorkspace.get(r.workspaceName) ?? []), r])
  const select =
    'h-8 w-full rounded-md border bg-background px-2 text-xs outline-none focus-visible:border-lemon-ink'
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-2 rounded-lg border bg-card p-3">
      <div className="flex items-center gap-2">
        <span className="grid size-6 place-items-center rounded-md bg-primary font-mono text-xs font-semibold text-primary-foreground">
          {side}
        </span>
        <span className="text-xs text-muted-foreground">{side === 'A' ? 'source' : 'target'}</span>
      </div>
      <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
        Source
        <select
          aria-label={`Source ${side}`}
          className={select}
          value={root}
          onChange={(e) =>
            onChange(e.target.value ? { root: e.target.value, project: null } : null)
          }
        >
          <option value="">Pick a source…</option>
          {[...byWorkspace].map(([ws, roots]) => (
            <optgroup key={ws} label={ws}>
              {roots.map((r) => (
                <option key={r.path} value={r.path}>
                  {r.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
        Project / directory
        <select
          aria-label={`Project ${side}`}
          className={select}
          disabled={!root || !projects}
          value={value ? toOption(value.project) : ''}
          onChange={(e) => root && onChange({ root, project: fromOption(e.target.value) })}
        >
          <option value="">{!root ? '—' : projects ? 'Pick a project…' : 'Scanning…'}</option>
          {(projects ?? []).map((p) => (
            <option key={toOption(p)} value={toOption(p)}>
              {p === null ? UNGROUPED : p === '.' ? 'root' : p}
            </option>
          ))}
        </select>
      </label>
      {error && (
        <p role="alert" className="text-[11px] text-bad">
          {error}
        </p>
      )}
    </div>
  )
}

/** "label · project" for a side, so identical relative paths from different sources read apart. */
export function SideLabel({ side }: { side: ProjectSide }): React.JSX.Element {
  const labelFor = useWorkspace((s) => s.labelFor)
  const kind = useWorkspace((s) => s.allRoots.find((r) => r.path === side.root)?.kind ?? 'local')
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <SourceIcon kind={kind} className="size-3 shrink-0 text-muted-foreground" />
      <span className="truncate" title={side.root}>
        {labelFor(side.root)}
      </span>
      <span className="text-muted-foreground">·</span>
      <span className="truncate">{side.project ?? UNGROUPED}</span>
    </span>
  )
}

const review = (p: PairReceipt): number =>
  p.receipt
    ? p.receipt.counts.changed +
      p.receipt.counts.missing +
      p.receipt.counts.extra +
      p.receipt.counts.blank +
      p.receipt.counts.unknown
    : 0

/**
 * Cross-source comparison: source + project on each side, matched environment
 * files with their receipts, and the files only one side has. Opening a pair
 * turns it into the ordinary A/B receipt with its plan.
 */
export function ProjectCompare(): React.JSX.Element {
  const {
    projectSides,
    projectResult,
    projectComparing,
    pickProjectSide,
    compareProjects,
    openPair,
    left
  } = useWorkspace()
  const swap = (): void => {
    const { left: l, right: r } = projectSides
    pickProjectSide('left', r)
    pickProjectSide('right', l)
  }
  // "Sync to another source…" arrives with A's file already ticked: prefill its project.
  useEffect(() => {
    if (left && !projectSides.left)
      pickProjectSide('left', { root: left.root, project: left.project })
  }, [left, projectSides.left, pickProjectSide])
  const ready = Boolean(projectSides.left && projectSides.right)
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b px-5">
        <div className="min-w-0 flex-1">
          <h1 className="text-base font-semibold tracking-tight">Compare projects</h1>
          <p className="truncate text-[11px] text-muted-foreground">
            Pick a source and a project on each side. Environment files are matched by their path
            inside the project; values stay redacted.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={swap}
          aria-label="Swap A and B"
          disabled={!ready}
        >
          <ArrowRightLeft /> Swap
        </Button>
        <Button
          size="sm"
          className="press"
          onClick={compareProjects}
          disabled={!ready || projectComparing}
        >
          <RefreshCw
            className={cn(projectComparing && 'animate-spin motion-reduce:animate-none')}
          />
          {projectComparing ? 'Comparing' : projectResult ? 'Compare again' : 'Compare projects'}
        </Button>
      </header>
      <div className="flex gap-3 border-b px-5 py-4">
        <SidePicker
          side="A"
          value={projectSides.left}
          onChange={(s) => pickProjectSide('left', s)}
        />
        <SidePicker
          side="B"
          value={projectSides.right}
          onChange={(s) => pickProjectSide('right', s)}
        />
      </div>
      {projectResult && (
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full text-sm" aria-label="Matched environment files">
            <thead className="sticky top-0 z-10 bg-background text-[11px] text-muted-foreground">
              <tr className="border-b [&>th]:h-9 [&>th]:px-5 [&>th]:text-left [&>th]:font-medium [&>th]:tracking-wide [&>th]:uppercase">
                <th>Environment</th>
                <th>A</th>
                <th>B</th>
                <th>Drift</th>
                <th className="w-28" />
              </tr>
            </thead>
            <tbody className="stagger">
              {projectResult.pairs.map((p, i) => (
                <tr
                  key={p.id}
                  style={{ '--i': i } as CSSProperties}
                  className="h-9 border-b [&>td]:px-5"
                >
                  <td className="font-mono text-xs">{p.id}</td>
                  <td className="max-w-0 truncate font-mono text-[11px] text-muted-foreground">
                    <SideLabel side={projectResult.left} /> · {p.left.rel}
                  </td>
                  <td className="max-w-0 truncate font-mono text-[11px] text-muted-foreground">
                    <SideLabel side={projectResult.right} /> · {p.right.rel}
                  </td>
                  <td className="text-xs">
                    {p.error ? (
                      <span className="text-bad" title={p.error}>
                        could not compare
                      </span>
                    ) : p.receipt?.clean ? (
                      <span className="text-ok">clean</span>
                    ) : (
                      <span className="text-warn">
                        {review(p)} key{review(p) === 1 ? '' : 's'} to review
                      </span>
                    )}
                  </td>
                  <td className="text-right">
                    {p.receipt && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-xs"
                        onClick={() => openPair(p)}
                      >
                        Open receipt <ArrowRight />
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
              {projectResult.pairs.length === 0 && (
                <tr>
                  <td colSpan={5} className="h-16 px-5 text-center text-xs text-muted-foreground">
                    No environment file exists on both sides under the same path.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          {(
            [
              ['Only in A', projectResult.onlyLeft, projectResult.left],
              ['Only in B', projectResult.onlyRight, projectResult.right]
            ] as const
          ).map(
            ([title, files, side]) =>
              files.length > 0 && (
                <section key={title} className="border-b px-5 py-3" aria-label={title}>
                  <h2 className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                    {title}
                  </h2>
                  <ul className="mt-1 space-y-0.5 font-mono text-xs">
                    {files.map((f) => (
                      <li key={f.path} className="flex items-center gap-2">
                        <SideLabel side={side} /> · {f.rel}
                        <span className="font-sans text-[11px] text-muted-foreground">
                          no counterpart, nothing is created automatically
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              )
          )}
          {projectResult.ambiguous.length > 0 && (
            <section className="border-b px-5 py-3" aria-label="Not paired">
              <h2 className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                Not paired
              </h2>
              <ul className="mt-1 space-y-0.5 font-mono text-xs">
                {projectResult.ambiguous.map((f) => (
                  <li key={f.path}>
                    {f.rel}{' '}
                    <span className="font-sans text-[11px] text-muted-foreground">
                      several files share this environment path; pick them as A and B by hand
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
      {!projectResult && (
        <p className="px-5 py-4 text-xs text-muted-foreground">
          Or mark two files as A and B in Workspace to compare them directly.
        </p>
      )}
    </div>
  )
}
