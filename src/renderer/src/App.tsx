import { useEffect, useRef } from 'react'
import { ArrowRightLeft, FolderSearch, PanelLeft, Search, Settings } from 'lucide-react'
import { toast } from 'sonner'
import { Logo } from '@/components/app/Logo'
import { StatusBar } from '@/components/app/StatusBar'
import { WorkspaceSwitcher } from '@/components/app/WorkspaceSwitcher'
import { ProjectList } from '@/components/app/ProjectList'
import { WorkspacePage } from '@/pages/Workspace'
import { ReceiptPage } from '@/pages/Receipt'
import { SettingsPage } from '@/pages/Settings'
import { OnboardingPage } from '@/pages/Onboarding'
import { useWorkspace, type PageId } from '@/store/workspace'
import { cn } from '@/lib/utils'
import { MAKER, PRODUCT } from '@shared/product'

const isMac = navigator.platform.startsWith('Mac')
const MOD = isMac ? '⌘' : 'Ctrl+'
/** The two working views. Settings is reached from the footer and Cmd/Ctrl+, */
const VIEWS: { id: PageId; label: string; icon: typeof FolderSearch }[] = [
  { id: 'workspace', label: 'Workspace', icon: FolderSearch },
  { id: 'receipt', label: 'Compare', icon: ArrowRightLeft }
]

/** Drag handle on the sidebar's right edge. */
function Resizer(): React.JSX.Element {
  const setWidth = useWorkspace((s) => s.setSidebarWidth)
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      title="Drag to resize"
      className="no-drag absolute top-0 right-0 z-10 h-full w-1.5 cursor-col-resize hover:bg-lemon-ink/40 active:bg-lemon-ink/60"
      onPointerDown={(e) => {
        e.preventDefault()
        const target = e.currentTarget
        target.setPointerCapture(e.pointerId)
        const move = (ev: PointerEvent): void => setWidth(ev.clientX)
        const up = (): void => {
          target.removeEventListener('pointermove', move)
          target.removeEventListener('pointerup', up)
        }
        target.addEventListener('pointermove', move)
        target.addEventListener('pointerup', up)
      }}
    />
  )
}

// ponytail: zustand page field as router. Move to TanStack Router when pages need deep links or params.
export default function App(): React.JSX.Element {
  const page = useWorkspace((s) => s.page)
  const setPage = useWorkspace((s) => s.setPage)
  const receipt = useWorkspace((s) => s.receipt)
  const paired = useWorkspace((s) => Boolean(s.left && s.right))
  const onboarded = useWorkspace((s) => s.onboarded)
  const collapsed = useWorkspace((s) => s.sidebarCollapsed)
  const toggleSidebar = useWorkspace((s) => s.toggleSidebar)
  const width = useWorkspace((s) => s.sidebarWidth)
  const fullscreen = useWorkspace((s) => s.fullscreen)
  const searchRef = useRef<HTMLInputElement>(null)

  const init = useWorkspace((s) => s.init)
  useEffect(() => {
    void init()
  }, [init])

  // Main → update lifecycle and full-screen state.
  useEffect(() => {
    const offUpdate = window.plumbr.onUpdate((e) => {
      if (e.kind === 'available') toast(`Downloading ${e.version} in the background`)
      else if (e.kind === 'downloaded')
        toast(`${e.version} is ready`, {
          duration: Infinity,
          action: { label: 'Restart to update', onClick: () => void window.plumbr.installUpdate() }
        })
    })
    const offFs = window.plumbr.onFullscreen((on) => useWorkspace.setState({ fullscreen: on }))
    return () => {
      offUpdate()
      offFs()
    }
  }, [])

  const focusSearch = (): void => {
    if (useWorkspace.getState().sidebarCollapsed) toggleSidebar()
    setTimeout(() => {
      searchRef.current?.focus()
      searchRef.current?.select()
    }, 0)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = isMac ? e.metaKey : e.ctrlKey
      if (!mod || e.altKey || e.shiftKey) return
      const k = e.key.toLowerCase()
      if (k === '1' || k === '2') {
        e.preventDefault()
        setPage(VIEWS[Number(k) - 1].id)
      } else if (k === ',') {
        e.preventDefault()
        setPage('settings')
      } else if (k === 'b') {
        e.preventDefault()
        toggleSidebar()
      } else if (k === 'f' && page === 'workspace') {
        e.preventDefault()
        focusSearch()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setPage, toggleSidebar, page])

  // First run: the journey owns the whole window until finished or skipped.
  if (onboarded === false) return <OnboardingPage />

  const compareDot = receipt
    ? receipt.clean
      ? 'bg-ok'
      : 'bg-warn'
    : paired
      ? 'bg-lemon-ink'
      : null
  // macOS traffic lights need a strip of their own unless the window is full screen.
  const strip = isMac && !fullscreen

  return (
    <div className="flex h-full">
      <aside
        style={{ width: collapsed ? 56 : width }}
        className="drag relative flex shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground transition-[width] duration-(--duration-base) ease-(--ease-out)"
        data-collapsed={collapsed || undefined}
      >
        {/* Top strip: traffic lights (mac), sidebar toggle, search. */}
        <div
          className={cn(
            'flex shrink-0 items-center gap-1 px-2',
            strip ? 'h-12 pt-1 pl-[max(0.5rem,env(titlebar-area-x,5rem))]' : 'h-10',
            collapsed && 'h-auto flex-col justify-center gap-1 px-0 py-2',
            collapsed && strip && 'pt-8'
          )}
        >
          {strip && !collapsed && <span className="w-16 shrink-0" aria-hidden="true" />}
          <button
            type="button"
            onClick={toggleSidebar}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-expanded={!collapsed}
            title={`${collapsed ? 'Expand' : 'Collapse'} sidebar (${MOD}B)`}
            className="no-drag press grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground"
          >
            <PanelLeft className="size-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => {
              setPage('workspace')
              focusSearch()
            }}
            aria-label="Search"
            title={`Search (${MOD}F)`}
            className="no-drag press grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground"
          >
            <Search className="size-4" aria-hidden="true" />
          </button>
        </div>

        {/* View switch */}
        <div
          role="tablist"
          aria-label="View"
          className={cn(
            'no-drag mx-2 mb-2 grid gap-1 rounded-lg bg-sidebar-accent/60 p-1',
            collapsed ? 'grid-cols-1' : 'grid-cols-2'
          )}
        >
          {VIEWS.map((v, i) => (
            <button
              key={v.id}
              type="button"
              role="tab"
              aria-selected={page === v.id}
              aria-label={collapsed ? v.label : undefined}
              title={`${v.label} (${MOD}${i + 1})`}
              onClick={() => setPage(v.id)}
              className={cn(
                'press relative flex h-8 items-center justify-center gap-1.5 rounded-md text-xs font-medium transition-colors duration-(--duration-fast)',
                page === v.id
                  ? 'elev bg-card text-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <v.icon
                className={cn('size-4', page === v.id && 'text-lemon-ink')}
                aria-hidden="true"
              />
              {!collapsed && v.label}
              {v.id === 'receipt' && compareDot && (
                <span
                  className={cn('absolute top-1.5 right-1.5 size-1.5 rounded-full', compareDot)}
                  aria-hidden="true"
                />
              )}
            </button>
          ))}
        </div>

        <div className="no-drag mb-1">
          <WorkspaceSwitcher collapsed={collapsed} />
        </div>

        {!collapsed && (
          <div className="no-drag flex min-h-0 flex-1 flex-col">
            <ProjectList searchRef={searchRef} onPick={() => setPage('workspace')} />
          </div>
        )}
        {collapsed && <div className="flex-1" />}

        {/* Footer: the brand on the left, settings on the right. */}
        <div
          className={cn(
            'no-drag flex shrink-0 items-center border-t px-2 py-1.5',
            collapsed ? 'justify-center' : 'gap-2'
          )}
        >
          {!collapsed && (
            <span className="flex min-w-0 flex-1 items-center gap-1.5 pl-1 text-xs whitespace-nowrap">
              <Logo size={16} />
              <span className="font-semibold">{PRODUCT}</span>
              <span className="text-[10px] text-muted-foreground">by {MAKER}</span>
            </span>
          )}
          <button
            type="button"
            onClick={() => setPage('settings')}
            aria-current={page === 'settings' ? 'page' : undefined}
            aria-label="Settings"
            title={`Settings (${MOD},)`}
            className={cn(
              'press grid size-8 shrink-0 place-items-center rounded-md hover:bg-sidebar-accent hover:text-sidebar-foreground',
              page === 'settings' ? 'bg-sidebar-accent text-lemon-ink' : 'text-muted-foreground'
            )}
          >
            <Settings className="size-4" aria-hidden="true" />
          </button>
        </div>
        {!collapsed && <Resizer />}
      </aside>

      <div className="relative flex min-w-0 flex-1 flex-col">
        <main className="min-h-0 min-w-0 flex-1 overflow-hidden" key={page}>
          <div className="enter h-full">
            {page === 'workspace' && <WorkspacePage />}
            {page === 'receipt' && <ReceiptPage />}
            {page === 'settings' && <SettingsPage />}
            {(page === 'sync' || page === 'share' || page === 'history' || page === 'agents') && (
              <SettingsPage />
            )}
          </div>
        </main>
        <StatusBar />
      </div>
    </div>
  )
}
