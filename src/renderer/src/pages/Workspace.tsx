import { useState, type CSSProperties } from 'react'
import {
  ArrowRight,
  ArrowRightLeft,
  FileText,
  Link2,
  Pencil,
  Plug,
  RefreshCw,
  ShieldCheck,
  Upload,
  X
} from 'lucide-react'
import { ContextMenu } from 'radix-ui'
import type { EnvFileInfo } from '@shared/channels'
import { envKind, type EnvKind } from '@shared/env-file'
import { Logo } from '@/components/app/Logo'
import { Lattice } from '@/components/app/Lattice'
import { EnvViewer } from '@/components/app/EnvViewer'
import { KIND_LABEL, KIND_TONE, useFileMatch, useGroups } from '@/lib/projects'
import { fmtAgo, fmtSize } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { UNGROUPED, splitProjectKey, useWorkspace } from '@/store/workspace'
import { AddSourceDialog } from '@/components/app/AddSourceDialog'
import { cn } from '@/lib/utils'
import { PRODUCT } from '@shared/product'

const CANON: EnvKind[] = ['base', 'local', 'staging', 'preview', 'production']

const FACTS: { k: string; t: string; d: string }[] = [
  {
    k: '01',
    t: 'What it reads',
    d: 'File names and dates first. Key names when you open a project. Values stay in the background and are only shown when you unlock one.'
  },
  {
    k: '02',
    t: 'What it writes',
    d: 'Nothing, until you approve a change. Every write takes a snapshot first, so you can always go back.'
  },
  {
    k: '03',
    t: 'Where it goes',
    d: 'Nowhere. No account, no server. The status bar at the bottom shows what was written and sent.'
  }
]

function Onboarding({ add }: { add: () => void }): React.JSX.Element {
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
          Runs on your machine · values hidden
        </p>
        <h1 className="hero-title mt-2" style={{ '--i': 4 } as CSSProperties}>
          Add a folder or a server to <span className="text-lemon-ink">{PRODUCT}</span>.
        </h1>
        <p
          className="mt-3 max-w-lg text-[15px] leading-relaxed text-muted-foreground"
          style={{ '--i': 5 } as CSSProperties}
        >
          It finds every <code className="font-mono text-foreground">.env</code> file inside, groups
          them by project, and leaves them where they are.
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
          <Button onClick={add} autoFocus size="lg" className="press cta-pulse">
            <Plug /> Select a source
          </Button>
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <ShieldCheck className="size-3.5 text-lemon-ink" aria-hidden="true" /> Only what you add
            can be read
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

/** Appears only once something is ticked; Compare needs two. */
function PairBar(): React.JSX.Element {
  const { left, right, pick, swap, setPage } = useWorkspace()
  return (
    <div className="enter flex h-14 shrink-0 items-center gap-3 border-t bg-card px-5">
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
        variant="ghost"
        onClick={() => {
          pick('left', null)
          pick('right', null)
        }}
      >
        Clear
      </Button>
      <Button
        size="sm"
        className="press"
        disabled={!left || !right}
        title={!left || !right ? 'Tick a second file to compare' : undefined}
        onClick={() => setPage('receipt')}
      >
        Compare <ArrowRight />
      </Button>
    </div>
  )
}

/** Right-click menu on a file row: compare, open, and the two roadmap actions. */
function RowMenu({
  file,
  children,
  onOpen
}: {
  file: EnvFileInfo
  children: React.ReactNode
  onOpen: () => void
}): React.JSX.Element {
  const { left, right, pick, setPage } = useWorkspace()
  const isL = left?.path === file.path
  const isR = right?.path === file.path
  const item =
    'flex h-7 cursor-default items-center gap-2 rounded-sm px-2 text-xs outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent'
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          className="enter z-50 min-w-52 rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
          aria-label={`Actions for ${file.rel}`}
        >
          <ContextMenu.Item className={item} onSelect={onOpen}>
            <FileText className="size-3.5" /> Open
          </ContextMenu.Item>
          <ContextMenu.Separator className="my-1 h-px bg-border" />
          <ContextMenu.Item className={item} onSelect={() => pick('left', isL ? null : file)}>
            <span className="grid size-4 place-items-center rounded-sm bg-primary font-mono text-[10px] font-semibold text-primary-foreground">
              A
            </span>
            {isL ? 'Remove from compare' : 'Compare as A (source)'}
          </ContextMenu.Item>
          <ContextMenu.Item className={item} onSelect={() => pick('right', isR ? null : file)}>
            <span className="grid size-4 place-items-center rounded-sm bg-primary font-mono text-[10px] font-semibold text-primary-foreground">
              B
            </span>
            {isR ? 'Remove from compare' : 'Compare as B (target)'}
          </ContextMenu.Item>
          {left && right && (
            <ContextMenu.Item className={item} onSelect={() => setPage('receipt')}>
              <ArrowRightLeft className="size-3.5" /> Open comparison
            </ContextMenu.Item>
          )}
          <ContextMenu.Separator className="my-1 h-px bg-border" />
          <ContextMenu.Item className={item} disabled>
            <Upload className="size-3.5" /> Sync to a platform…
            <span className="ml-auto font-mono text-[9px] tracking-wide uppercase">soon</span>
          </ContextMenu.Item>
          <ContextMenu.Item className={item} disabled>
            <Link2 className="size-3.5" /> Share with a link…
            <span className="ml-auto font-mono text-[9px] tracking-wide uppercase">soon</span>
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  )
}

export function WorkspacePage(): React.JSX.Element {
  const {
    roots,
    scan,
    scanning,
    error,
    rescan,
    project,
    summaries,
    left,
    right,
    search,
    viewerDirty,
    setViewerDirty
  } = useWorkspace()
  const groups = useGroups()
  const fileMatches = useFileMatch()
  const [open, setOpen] = useState<EnvFileInfo | null>(null)
  const openPath = open?.path ?? null
  const [dialog, setDialog] = useState<'new' | 'edit' | null>(null)

  if (roots.length === 0)
    return (
      <>
        <Onboarding add={() => setDialog('new')} />
        {dialog && <AddSourceDialog mode={dialog} onClose={() => setDialog(null)} />}
      </>
    )

  const q = search.trim().toLowerCase()
  const allFiles = groups.find((g) => g.key === project)?.fs ?? []
  const selected = project ? splitProjectKey(project) : null
  const files =
    q && !(selected?.project ?? '').toLowerCase().includes(q)
      ? allFiles.filter(fileMatches)
      : allFiles
  const present = new Map<EnvKind, number>()
  for (const f of files) present.set(envKind(f.name), (present.get(envKind(f.name)) ?? 0) + 1)
  const source = roots[0]
  const title =
    selected?.project === UNGROUPED
      ? 'Files outside any Git project'
      : selected?.project === '.'
        ? (roots.find((r) => r.path === selected.root)?.label ?? selected.root)
        : selected?.project

  return (
    <div className="@container flex h-full flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b px-5">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-base font-semibold tracking-tight">
            {title ?? 'Workspace'}
          </h1>
          <p
            className="truncate font-mono text-[11px] text-muted-foreground"
            title={roots.map((r) => r.path).join('\n')}
          >
            {roots.length === 1 ? source.label : `${roots.length} roots`}
            {scan && !scanning && ` · ${scan.files.length} files · ${scan.scannedDirs} folders`}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={rescan} disabled={scanning}>
          <RefreshCw className={cn(scanning && 'animate-spin motion-reduce:animate-none')} />
          {scanning ? 'Scanning' : 'Rescan'}
        </Button>
        <Button variant="outline" size="sm" onClick={() => setDialog('edit')}>
          <Pencil /> Update source
        </Button>
        {dialog && <AddSourceDialog mode={dialog} onClose={() => setDialog(null)} />}
      </header>

      {scanning && <div className="scanline -mt-0.5 shrink-0" aria-hidden="true" />}

      {error && (
        <p
          role="alert"
          className="border-b bg-bad-soft px-4 py-2 text-xs whitespace-pre-line text-bad"
        >
          {error}
        </p>
      )}

      {scanning && !scan ? (
        <div className="space-y-2 p-4">
          <Skeleton className="h-6 w-1/3" />
          <Skeleton className="h-8" />
          <Skeleton className="h-8" />
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
        <section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label="Environment overview">
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
            <>
              {project && (
                <div className="border-b px-5 py-3">
                  <ul className="flex flex-wrap gap-1.5" aria-label="Environments present">
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
                      <th className="w-16 text-right">Compare</th>
                    </tr>
                  </thead>
                  <tbody className="stagger" key={project ?? ''}>
                    {files.map((f, i) => {
                      const isL = left?.path === f.path
                      const isR = right?.path === f.path
                      const s = summaries[f.path]
                      const kind = envKind(f.name)
                      const openFile = (): void => {
                        if (
                          viewerDirty &&
                          !window.confirm('Discard unsaved changes to the open file?')
                        )
                          return
                        setOpen(openPath === f.path ? null : f)
                      }
                      return (
                        <RowMenu key={f.path} file={f} onOpen={openFile}>
                          <tr
                            style={{ '--i': i } as CSSProperties}
                            tabIndex={0}
                            role="button"
                            aria-label={`Open ${f.rel}`}
                            onClick={openFile}
                            onKeyDown={(e) => e.key === 'Enter' && openFile()}
                            className={cn(
                              'cursor-pointer border-b transition-colors duration-(--duration-fast) outline-none focus-visible:bg-accent/60 [&>td]:h-11 [&>td]:px-3 [&>td]:whitespace-nowrap [&>td:first-child]:pl-5',
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
                              <div className="truncate font-mono text-xs" title={f.rel}>
                                {f.name}
                              </div>
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
                            <td className="text-right font-mono text-[11px]">
                              {(isL || isR) && (
                                <span className="rounded-sm bg-primary px-1 font-semibold text-primary-foreground">
                                  {isL ? 'A' : 'B'}
                                </span>
                              )}
                            </td>
                          </tr>
                        </RowMenu>
                      )
                    })}
                  </tbody>
                </table>
                <p className="px-5 py-2 text-[11px] text-muted-foreground">
                  Click a file to open it. Right-click to compare, sync or share.
                </p>
              </div>
            </>
          )}
        </section>
      ) : null}

      {(left || right) && <PairBar />}
    </div>
  )
}
