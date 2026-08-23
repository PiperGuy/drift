import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import {
  ArrowRight,
  ArrowRightLeft,
  FolderOpen,
  GitBranch,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  X
} from 'lucide-react'
import type { EnvFileInfo } from '@shared/channels'
import { ENV_KINDS, envKind, type EnvKind } from '@shared/env-file'
import { Logo } from '@/components/app/Logo'
import { Lattice } from '@/components/app/Lattice'
import { EnvViewer } from '@/components/app/EnvViewer'
import { fmtAgo, fmtSize } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { UNGROUPED, projectKey, splitProjectKey, useWorkspace } from '@/store/workspace'
import { AddSshDialog } from '@/components/app/AddSshDialog'
import { cn } from '@/lib/utils'
import { PRODUCT } from '@shared/product'

const isMacPlatform = navigator.platform.startsWith('Mac')

const KIND_LABEL: Record<EnvKind, string> = {
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
const KIND_TONE: Record<EnvKind, string> = {
  base: 'bg-ok-soft text-ok border-ok/20',
  local: 'bg-ok-soft text-ok border-ok/20',
  development: 'bg-ok-soft text-ok border-ok/20',
  staging: 'bg-warn-soft text-warn border-warn/20',
  preview: 'bg-lemon-soft text-lemon-ink border-lemon-ink/20',
  production: 'bg-bad-soft text-bad border-bad/20',
  example: 'bg-muted text-muted-foreground border-border',
  other: 'bg-muted text-muted-foreground border-border'
}
/** The environments the product promises to show side by side. */
const CANON: EnvKind[] = ['base', 'local', 'staging', 'preview', 'production']

const FACTS: { k: string; t: string; d: string }[] = [
  {
    k: '01',
    t: 'Scan reads',
    d: 'File names, paths, sizes and modified times. Contents are never opened.'
  },
  {
    k: '02',
    t: 'Inspect reads',
    d: 'Key names and a per-launch fingerprint of each value, in the main process. This window never receives a value.'
  },
  {
    k: '03',
    t: 'This build',
    d: 'Compares two local files and describes a plan. It writes nothing and sends nothing.'
  }
]

function Onboarding({ grant }: { grant: () => void }): React.JSX.Element {
  return (
    <div className="relative flex h-full items-center justify-center overflow-auto p-8">
      <Lattice className="absolute inset-0 size-full [mask-image:radial-gradient(ellipse_at_center,transparent_22%,black_80%)]" />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-1/2 size-[34rem] -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary/10 blur-3xl"
      />
      <div className="stagger relative w-full max-w-2xl">
        <Logo size={48} draw />
        <p
          className="mt-6 font-mono text-[11px] tracking-[0.2em] text-lemon-ink uppercase"
          style={{ '--i': 3 } as CSSProperties}
        >
          Local-first · redacted by default
        </p>
        <h1 className="hero-title mt-2" style={{ '--i': 4 } as CSSProperties}>
          Point <span className="text-lemon-ink">{PRODUCT}</span> at a folder.
        </h1>
        <p
          className="mt-3 max-w-lg text-[15px] leading-relaxed text-muted-foreground"
          style={{ '--i': 5 } as CSSProperties}
        >
          It lists every <code className="font-mono text-foreground">.env*</code> inside, grouped by
          Git project, and leaves each file exactly where it is.
        </p>
        <dl
          className="stagger mt-8 grid gap-3 sm:grid-cols-3"
          style={{ '--i': 6 } as CSSProperties}
        >
          {FACTS.map((f, i) => (
            <div
              key={f.k}
              className="elev rounded-lg border bg-card/80 p-4 backdrop-blur-sm"
              style={{ '--i': 7 + i } as CSSProperties}
            >
              <dt className="flex items-center gap-2 text-[13px] font-medium">
                <span className="font-mono text-[10px] text-lemon-ink">{f.k}</span>
                {f.t}
              </dt>
              <dd className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{f.d}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-8 flex items-center gap-4" style={{ '--i': 11 } as CSSProperties}>
          <Button onClick={grant} autoFocus size="lg" className="press cta-pulse">
            <FolderOpen /> Choose a folder
          </Button>
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <ShieldCheck className="size-3.5 text-lemon-ink" aria-hidden="true" /> Only this folder
            is readable afterwards
          </span>
        </div>
      </div>
    </div>
  )
}

function PairSlot({
  side,
  file,
  clear
}: {
  side: 'A' | 'B'
  file: EnvFileInfo | null
  clear: () => void
}): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <span
        key={file?.path ?? 'empty'}
        className={cn(
          'fill grid size-6 shrink-0 place-items-center rounded-md font-mono text-xs font-semibold',
          file
            ? 'elev bg-primary text-primary-foreground'
            : 'border border-dashed text-muted-foreground'
        )}
      >
        {side}
      </span>
      {file ? (
        <>
          <span className="truncate font-mono text-xs" title={file.rel}>
            {file.rel}
          </span>
          <Button size="icon-xs" variant="ghost" aria-label={`Clear ${side}`} onClick={clear}>
            <X />
          </Button>
        </>
      ) : (
        <span className="text-xs text-muted-foreground">
          {side === 'A' ? 'pick a source' : 'pick a target'}
        </span>
      )}
    </div>
  )
}

function PairBar(): React.JSX.Element {
  const { left, right, pick, swap, setPage } = useWorkspace()
  return (
    <div className="flex h-14 shrink-0 items-center gap-3 border-t bg-card px-5">
      <PairSlot side="A" file={left} clear={() => pick('left', null)} />
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label="Swap A and B"
        disabled={!left && !right}
        onClick={swap}
      >
        <ArrowRightLeft />
      </Button>
      <PairSlot side="B" file={right} clear={() => pick('right', null)} />
      <Button
        size="sm"
        className="press"
        disabled={!left || !right}
        onClick={() => setPage('receipt')}
      >
        Open receipt <ArrowRight />
      </Button>
    </div>
  )
}

export function WorkspacePage(): React.JSX.Element {
  const {
    roots,
    scan,
    scanning,
    error,
    grant,
    removeRoot,
    rescan,
    project,
    openProject,
    summaries,
    left,
    right,
    pick
  } = useWorkspace()

  type Group = { key: string; root: string; name: string; fs: EnvFileInfo[] }
  const groups = useMemo<Group[]>(() => {
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
  const [sshOpen, setSshOpen] = useState(false)

  const [open, setOpen] = useState<EnvFileInfo | null>(null)
  const openPath = open?.path ?? null
  const viewerDirty = useWorkspace((s) => s.viewerDirty)
  const setViewerDirty = useWorkspace((s) => s.setViewerDirty)

  // Search: project name, file path, and key names for projects already inspected.
  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const q = query.trim().toLowerCase()
  const fileMatches = (f: EnvFileInfo): boolean =>
    !q ||
    f.rel.toLowerCase().includes(q) ||
    (summaries[f.path]?.names.some((k) => k.key.toLowerCase().includes(q)) ?? false)
  const visibleGroups = q
    ? groups.filter((g) => g.name.toLowerCase().includes(q) || g.fs.some(fileMatches))
    : groups

  if (roots.length === 0) return <Onboarding grant={grant} />

  const allFiles = groups.find((g) => g.key === project)?.fs ?? []
  // A query that matched the project name keeps every file; otherwise narrow to matching files.
  const selected = project ? splitProjectKey(project) : null
  const files =
    q && !(selected?.project ?? '').toLowerCase().includes(q)
      ? allFiles.filter(fileMatches)
      : allFiles
  const present = new Map<EnvKind, number>()
  for (const f of files) present.set(envKind(f.name), (present.get(envKind(f.name)) ?? 0) + 1)

  return (
    <div className="@container flex h-full flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b px-5">
        <div className="min-w-0 flex-1">
          <h1 className="text-base font-semibold tracking-tight">Workspace</h1>
          <p
            className="truncate font-mono text-[11px] text-muted-foreground"
            title={roots.map((r) => r.label).join('\n')}
          >
            {roots.length === 1
              ? roots[0].label
              : `${roots.length} roots · ${roots.filter((r) => r.kind === 'ssh').length} over ssh`}
          </p>
        </div>
        {scan && !scanning && (
          <span className="hidden font-mono text-[11px] text-muted-foreground md:inline">
            {scan.scannedDirs} folders · {scan.durationMs} ms
          </span>
        )}
        <Button variant="outline" size="sm" onClick={rescan} disabled={scanning}>
          <RefreshCw className={cn(scanning && 'animate-spin motion-reduce:animate-none')} />
          {scanning ? 'Scanning' : 'Rescan'}
        </Button>
        <Button variant="outline" size="sm" onClick={grant}>
          <FolderOpen /> Add folder
        </Button>
        <Button variant="outline" size="sm" onClick={() => setSshOpen(true)}>
          <Server /> Add SSH
        </Button>
        {sshOpen && <AddSshDialog onClose={() => setSshOpen(false)} />}
      </header>

      {scanning && <div className="scanline -mt-0.5 shrink-0" aria-hidden="true" />}

      {error && (
        <p role="alert" className="border-b bg-bad-soft px-4 py-2 text-xs text-bad">
          {error}
        </p>
      )}

      {scanning && !scan ? (
        <div className="grid flex-1 grid-cols-[14rem_1fr]">
          <div className="space-y-2 border-r p-3">
            <Skeleton className="h-8" />
            <Skeleton className="h-8" />
          </div>
          <div className="space-y-2 p-4">
            <Skeleton className="h-6 w-1/3" />
            <Skeleton className="h-8" />
            <Skeleton className="h-8" />
          </div>
        </div>
      ) : scan && scan.files.length === 0 ? (
        <div className="dotgrid flex flex-1 items-center justify-center p-8 text-center">
          <div className="elev max-w-sm rounded-lg border bg-card p-5">
            <p className="text-sm font-medium">No .env files here</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {scan.scannedDirs} folders scanned. Build, dependency and VCS directories are skipped.
              Try a parent folder or a different project.
            </p>
          </div>
        </div>
      ) : scan ? (
        <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[auto_1fr] @3xl:grid-cols-[14rem_minmax(0,1fr)] @3xl:grid-rows-1">
          <nav
            aria-label="Projects"
            className="flex items-start gap-1 overflow-auto border-b p-2 @3xl:flex-col @3xl:items-stretch @3xl:border-r @3xl:border-b-0"
          >
            <div className="relative mb-1 w-full shrink-0">
              <Search
                className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                ref={searchRef}
                aria-label="Search projects, files and keys"
                placeholder={`Search (${isMacPlatform ? '⌘' : 'Ctrl+'}F)`}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
                className="h-7 pl-7 font-mono text-xs"
              />
              {query && (
                <button
                  type="button"
                  aria-label="Clear search"
                  onClick={() => setQuery('')}
                  className="absolute top-1/2 right-1.5 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  <X className="size-3.5" />
                </button>
              )}
            </div>
            {roots.map((rootInfo) => {
              const mine = visibleGroups.filter((g) => g.root === rootInfo.path)
              if (q && mine.length === 0) return null
              return (
                <div key={rootInfo.path} className="contents">
                  <div className="mt-1 flex w-full items-center gap-1.5 px-1 pt-1 text-[10px] font-medium tracking-widest text-muted-foreground uppercase first:mt-0">
                    {rootInfo.kind === 'ssh' ? (
                      <Server className="size-3" />
                    ) : (
                      <FolderOpen className="size-3" />
                    )}
                    <span className="min-w-0 flex-1 truncate normal-case" title={rootInfo.path}>
                      {rootInfo.label}
                    </span>
                    <button
                      type="button"
                      aria-label={`Remove ${rootInfo.label}`}
                      title="Stop reading this root"
                      onClick={() => {
                        if (window.confirm(`Stop reading ${rootInfo.label}? Files are untouched.`))
                          void removeRoot(rootInfo.path)
                      }}
                      className="rounded p-0.5 hover:bg-accent hover:text-foreground"
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                  {mine.length === 0 && (
                    <p className="px-2 py-2 text-xs text-muted-foreground">No .env files here.</p>
                  )}
                  {mine.map((g) => {
                    const { key, name, fs } = g
                    const active = key === project
                    const kinds = [...new Set(fs.map((f) => envKind(f.name)))]
                    return (
                      <div key={key} className="contents">
                        <button
                          type="button"
                          aria-current={active ? 'true' : undefined}
                          onClick={() => {
                            // Switching projects closes the open file; unsaved edits ask first.
                            if (
                              viewerDirty &&
                              !window.confirm('Discard unsaved changes to the open file?')
                            )
                              return
                            setOpen(null)
                            setViewerDirty(false)
                            void openProject(key)
                          }}
                          className={cn(
                            'press flex shrink-0 flex-col gap-1 rounded-lg border px-2.5 py-2 text-left transition-colors duration-(--duration-fast) @3xl:w-full',
                            active
                              ? 'elev border-border bg-card'
                              : 'border-transparent hover:bg-accent/50'
                          )}
                        >
                          <span className="flex items-center gap-1.5 text-[13px]">
                            {name === UNGROUPED ? (
                              <span className="text-muted-foreground">no Git project</span>
                            ) : (
                              <>
                                <GitBranch
                                  className="size-3.5 shrink-0 text-muted-foreground"
                                  aria-hidden="true"
                                />
                                <span className="truncate font-medium">
                                  {name === '.' ? 'root' : name}
                                </span>
                              </>
                            )}
                            <span className="ml-auto font-mono text-[11px] text-muted-foreground">
                              {fs.length}
                            </span>
                          </span>
                          <span className="flex flex-wrap gap-1">
                            {ENV_KINDS.filter((k) => kinds.includes(k)).map((k) => (
                              <span
                                key={k}
                                className={cn(
                                  'rounded-sm border px-1 font-mono text-[10px]',
                                  KIND_TONE[k]
                                )}
                              >
                                {KIND_LABEL[k]}
                              </span>
                            ))}
                          </span>
                        </button>
                      </div>
                    )
                  })}
                </div>
              )
            })}
            {q && visibleGroups.length === 0 && (
              <p className="px-2 py-3 text-xs text-muted-foreground">
                No project, file or key matches.
              </p>
            )}
          </nav>

          <section className="flex min-h-0 min-w-0 flex-col" aria-label="Environment overview">
            <div className="flex min-h-0 min-w-0 flex-1">
              {open ? (
                <EnvViewer
                  key={open.path}
                  file={files.find((f) => f.path === open.path) ?? open}
                  onClose={() => {
                    setOpen(null)
                    setViewerDirty(false)
                  }}
                  onDirtyChange={setViewerDirty}
                />
              ) : (
                <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                  {project && (
                    <div className="border-b px-5 py-3.5">
                      <h2 className="text-sm font-semibold tracking-tight">
                        {selected?.project === UNGROUPED
                          ? 'Files outside any Git project'
                          : selected?.project === '.'
                            ? (roots.find((r) => r.path === selected.root)?.label ?? selected.root)
                            : selected?.project}
                      </h2>
                      <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Environments present">
                        {CANON.map((k) => {
                          const n = present.get(k) ?? 0
                          return (
                            <li
                              key={k}
                              className={cn(
                                'inline-flex h-6 items-center gap-1.5 rounded-md border px-2 font-mono text-[11px]',
                                n ? cn('elev', KIND_TONE[k]) : 'border-dashed text-muted-foreground'
                              )}
                            >
                              <span aria-hidden="true">{n ? '●' : '○'}</span>
                              {KIND_LABEL[k]}
                              <span className="sr-only">{n ? `, ${n} present` : ', absent'}</span>
                            </li>
                          )
                        })}
                      </ul>
                    </div>
                  )}
                  <div className="min-h-0 flex-1 overflow-auto">
                    <table className="w-full text-sm">
                      <thead className="sticky top-0 z-10 bg-background text-[11px] text-muted-foreground">
                        <tr className="border-b [&>th]:h-9 [&>th]:px-3 [&>th]:text-left [&>th]:font-medium [&>th]:tracking-wide [&>th]:uppercase [&>th]:whitespace-nowrap [&>th:first-child]:pl-5">
                          <th>Environment</th>
                          <th className="w-2/5">File</th>
                          <th className="text-right">Keys</th>
                          <th className="hidden @4xl:table-cell">Modified</th>
                          <th className="hidden text-right @4xl:table-cell">Size</th>
                          <th className="w-24 text-right">Compare</th>
                        </tr>
                      </thead>
                      <tbody className="stagger" key={project ?? ''}>
                        {files.map((f, i) => {
                          const isL = left?.path === f.path
                          const isR = right?.path === f.path
                          const s = summaries[f.path]
                          const kind = envKind(f.name)
                          return (
                            <tr
                              key={f.path}
                              style={{ '--i': i } as CSSProperties}
                              className={cn(
                                'border-b transition-colors duration-(--duration-fast) [&>td]:h-11 [&>td]:px-3 [&>td]:whitespace-nowrap [&>td:first-child]:pl-5',
                                isL || isR ? 'bg-lemon-soft/70' : 'hover:bg-accent/40'
                              )}
                            >
                              <td>
                                <span
                                  className={cn(
                                    'rounded-md border px-1.5 py-0.5 font-mono text-[11px]',
                                    KIND_TONE[kind]
                                  )}
                                >
                                  {KIND_LABEL[kind]}
                                </span>
                              </td>
                              <td className="max-w-0">
                                <button
                                  type="button"
                                  onClick={() => setOpen(openPath === f.path ? null : f)}
                                  aria-expanded={openPath === f.path}
                                  aria-label={`Keys in ${f.rel}`}
                                  className={cn(
                                    'block w-full truncate text-left font-mono text-xs underline-offset-2 hover:underline',
                                    openPath === f.path && 'text-lemon-ink'
                                  )}
                                  title={f.rel}
                                >
                                  {f.name}
                                </button>
                                {f.rel !== f.name && (
                                  <div className="truncate font-mono text-[10px] text-muted-foreground">
                                    {f.rel.slice(0, -f.name.length)}
                                  </div>
                                )}
                              </td>
                              <td className="text-right font-mono text-xs">
                                {s ? (
                                  <span title={`${s.keys} keys, ${s.blank} blank`}>
                                    {s.keys}
                                    {s.blank > 0 && (
                                      <span className="text-muted-foreground">
                                        {' '}
                                        · {s.blank} blank
                                      </span>
                                    )}
                                  </span>
                                ) : (
                                  <span className="text-muted-foreground">…</span>
                                )}
                              </td>
                              <td className="hidden text-xs text-muted-foreground @4xl:table-cell">
                                <span title={new Date(f.modifiedAt).toLocaleString()}>
                                  {fmtAgo(f.modifiedAt)}
                                </span>
                              </td>
                              <td className="hidden text-right font-mono text-xs text-muted-foreground @4xl:table-cell">
                                {fmtSize(f.size)}
                              </td>
                              <td className="text-right">
                                <div
                                  className="inline-flex gap-1"
                                  role="group"
                                  aria-label={`Compare ${f.rel}`}
                                >
                                  <Button
                                    size="xs"
                                    variant={isL ? 'default' : 'outline'}
                                    aria-pressed={isL}
                                    aria-label={`Use ${f.rel} as A`}
                                    onClick={() => pick('left', isL ? null : f)}
                                  >
                                    A
                                  </Button>
                                  <Button
                                    size="xs"
                                    variant={isR ? 'default' : 'outline'}
                                    aria-pressed={isR}
                                    aria-label={`Use ${f.rel} as B`}
                                    onClick={() => pick('right', isR ? null : f)}
                                  >
                                    B
                                  </Button>
                                </div>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          </section>
        </div>
      ) : null}

      {scan && scan.files.length > 0 && <PairBar />}
    </div>
  )
}
