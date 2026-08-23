import { type CSSProperties } from 'react'
import { FolderOpen, GitBranch, Search, Server, X } from 'lucide-react'
import { ENV_KINDS, envKind } from '@shared/env-file'
import { Input } from '@/components/ui/input'
import { UNGROUPED, useWorkspace } from '@/store/workspace'
import { KIND_LABEL, KIND_TONE, useFileMatch, useGroups } from '@/lib/projects'
import { cn } from '@/lib/utils'

/**
 * The project directory of the active source, in the sidebar. Search filters
 * projects by name, files by path, and keys for projects already inspected.
 */
export function ProjectList({
  searchRef,
  onPick
}: {
  searchRef: React.RefObject<HTMLInputElement | null>
  onPick?: () => void
}): React.JSX.Element {
  const {
    roots,
    project,
    openProject,
    search,
    setSearch,
    viewerDirty,
    setViewerDirty,
    removeRoot
  } = useWorkspace()
  const groups = useGroups()
  const fileMatches = useFileMatch()
  const q = search.trim().toLowerCase()
  const visible = q
    ? groups.filter((g) => g.name.toLowerCase().includes(q) || g.fs.some(fileMatches))
    : groups
  const isMac = navigator.platform.startsWith('Mac')

  return (
    <nav aria-label="Projects" className="flex min-h-0 flex-1 flex-col">
      <div className="relative mx-2 mb-1 shrink-0">
        <Search
          className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          ref={searchRef}
          aria-label="Search projects, files and keys"
          placeholder={`Search (${isMac ? '⌘' : 'Ctrl+'}F)`}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && setSearch('')}
          className="h-7 pl-7 font-mono text-xs"
        />
        {search && (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => setSearch('')}
            className="absolute top-1/2 right-1.5 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-2 pb-2">
        {roots.map((rootInfo) => {
          const mine = visible.filter((g) => g.root === rootInfo.path)
          if (q && mine.length === 0) return null
          return (
            <div key={rootInfo.path}>
              {roots.length > 1 && (
                <div className="mt-2 flex items-center gap-1.5 px-1 pb-1 text-[10px] font-medium tracking-widest text-muted-foreground uppercase first:mt-0">
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
              )}
              {mine.length === 0 && (
                <p className="px-2 py-2 text-xs text-muted-foreground">No .env files here.</p>
              )}
              <ul className="stagger space-y-0.5">
                {mine.map((g, i) => {
                  const active = g.key === project
                  const kinds = [...new Set(g.fs.map((f) => envKind(f.name)))]
                  return (
                    <li key={g.key} style={{ '--i': i } as CSSProperties}>
                      <button
                        type="button"
                        aria-current={active ? 'true' : undefined}
                        onClick={() => {
                          if (
                            viewerDirty &&
                            !window.confirm('Discard unsaved changes to the open file?')
                          )
                            return
                          setViewerDirty(false)
                          void openProject(g.key)
                          onPick?.()
                        }}
                        className={cn(
                          'press flex w-full flex-col gap-1 rounded-md px-2 py-1.5 text-left transition-colors duration-(--duration-fast)',
                          active ? 'bg-sidebar-accent' : 'hover:bg-sidebar-accent/60'
                        )}
                      >
                        <span className="flex items-center gap-1.5 text-[13px]">
                          {g.name === UNGROUPED ? (
                            <span className="text-muted-foreground">no Git project</span>
                          ) : (
                            <>
                              <GitBranch
                                className="size-3.5 shrink-0 text-muted-foreground"
                                aria-hidden="true"
                              />
                              <span className="truncate font-medium">
                                {g.name === '.' ? 'root' : g.name}
                              </span>
                            </>
                          )}
                          <span className="ml-auto font-mono text-[11px] text-muted-foreground">
                            {g.fs.length}
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
                    </li>
                  )
                })}
              </ul>
            </div>
          )
        })}
        {q && visible.length === 0 && (
          <p className="px-2 py-3 text-xs text-muted-foreground">
            No project, file or key matches.
          </p>
        )}
      </div>
    </nav>
  )
}
