import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  Bot,
  FolderSearch,
  History,
  Link2,
  PanelLeftClose,
  PanelLeftOpen,
  Receipt,
  Settings,
  Upload,
  type LucideIcon
} from 'lucide-react'
import { Logo } from '@/components/app/Logo'
import { ThemeToggle } from '@/components/app/ThemeToggle'
import { StatusBar } from '@/components/app/StatusBar'
import { WorkspacePage } from '@/pages/Workspace'
import { ReceiptPage } from '@/pages/Receipt'
import { PlannedPage } from '@/pages/Planned'
import { SettingsPage } from '@/pages/Settings'
import { useWorkspace, type PageId } from '@/store/workspace'
import { cn } from '@/lib/utils'
import { MAKER, PRODUCT } from '@shared/product'

type NavItem = { id: PageId; label: string; icon: LucideIcon }

/** What runs on this machine today. */
const LOCAL: NavItem[] = [
  { id: 'workspace', label: 'Workspace', icon: FolderSearch },
  { id: 'receipt', label: 'Receipt', icon: Receipt }
]
/** Surfaces that exist on the site roadmap but are not implemented in this build. */
const ROADMAP: NavItem[] = [
  { id: 'sync', label: 'Sync', icon: Upload },
  { id: 'share', label: 'Share', icon: Link2 },
  { id: 'history', label: 'History', icon: History },
  { id: 'agents', label: 'Agents', icon: Bot }
]
const ORDER: PageId[] = [...LOCAL, ...ROADMAP].map((n) => n.id).concat('settings')

const isMac = navigator.platform.startsWith('Mac')
const MOD = isMac ? '⌘' : 'Ctrl'

function NavButton({
  id,
  label,
  icon: Icon,
  active,
  dot,
  collapsed,
  onSelect
}: NavItem & {
  active: boolean
  dot: string | null
  collapsed: boolean
  onSelect: (id: PageId) => void
}): React.JSX.Element {
  const i = ORDER.indexOf(id) + 1
  return (
    <button
      type="button"
      onClick={() => onSelect(id)}
      aria-current={active ? 'page' : undefined}
      aria-label={collapsed ? label : undefined}
      title={`${label} (${MOD}${i})`}
      className={cn(
        'press group relative flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-left text-[13px] transition-colors duration-(--duration-fast)',
        collapsed && 'justify-center px-0',
        active
          ? 'font-medium text-sidebar-accent-foreground'
          : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground'
      )}
    >
      <Icon className={cn('size-4 shrink-0', active && 'text-lemon-ink')} aria-hidden="true" />
      {collapsed ? (
        dot && (
          <span
            className={cn('absolute top-1.5 right-1.5 size-1.5 rounded-full', dot)}
            aria-hidden="true"
          />
        )
      ) : (
        <>
          <span className="flex-1 truncate">{label}</span>
          {dot && <span className={cn('size-1.5 rounded-full', dot)} aria-hidden="true" />}
          <kbd className="opacity-0 transition-opacity group-hover:opacity-100">{i}</kbd>
        </>
      )}
    </button>
  )
}

// ponytail: zustand page field as router. Move to TanStack Router when pages need deep links or params.
export default function App(): React.JSX.Element {
  const page = useWorkspace((s) => s.page)
  const setPage = useWorkspace((s) => s.setPage)
  const receipt = useWorkspace((s) => s.receipt)
  const paired = useWorkspace((s) => Boolean(s.left && s.right))
  const collapsed = useWorkspace((s) => s.sidebarCollapsed)
  const toggleSidebar = useWorkspace((s) => s.toggleSidebar)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = isMac ? e.metaKey : e.ctrlKey
      if (!mod || e.altKey || e.shiftKey) return
      const n = Number(e.key)
      if (n >= 1 && n <= ORDER.length) {
        e.preventDefault()
        setPage(ORDER[n - 1])
      } else if (e.key === ',') {
        e.preventDefault()
        setPage('settings')
      } else if (e.key.toLowerCase() === 'b') {
        e.preventDefault()
        toggleSidebar()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setPage, toggleSidebar])

  const receiptDot = receipt
    ? receipt.clean
      ? 'bg-ok'
      : 'bg-warn'
    : paired
      ? 'bg-lemon-ink'
      : null
  const item = (n: NavItem): React.JSX.Element => (
    <div key={n.id} data-nav={n.id}>
      <NavButton
        {...n}
        active={page === n.id}
        dot={n.id === 'receipt' ? receiptDot : null}
        collapsed={collapsed}
        onSelect={setPage}
      />
    </div>
  )

  // One lemon indicator slides to the active item. Measured, not computed, so
  // section headings and gaps never need to be mirrored in JS.
  const navRef = useRef<HTMLElement>(null)
  const [ind, setInd] = useState<{ y: number; h: number } | null>(null)
  useLayoutEffect(() => {
    const nav = navRef.current
    const el = nav?.querySelector<HTMLElement>(`[data-nav="${page}"]`)
    if (!nav || !el) return
    setInd({ y: el.offsetTop, h: el.offsetHeight })
  }, [page, collapsed])

  return (
    <div className="flex h-full">
      <aside
        className={cn(
          'drag flex shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground transition-[width] duration-(--duration-base) ease-(--ease-out)',
          collapsed ? 'w-14' : 'w-52'
        )}
        data-collapsed={collapsed || undefined}
      >
        <div
          className={cn(
            'flex h-12 items-center gap-2.5 pt-1',
            collapsed ? 'justify-center' : 'px-3 pl-[max(0.75rem,env(titlebar-area-x,0.75rem))]'
          )}
        >
          <Logo size={24} />
          {!collapsed && (
            <span className="flex items-baseline gap-1.5 text-sm font-semibold tracking-tight whitespace-nowrap">
              {PRODUCT}
              <span className="text-[10px] font-medium tracking-wide text-muted-foreground">
                by {MAKER}
              </span>
            </span>
          )}
        </div>
        <nav
          ref={navRef}
          className="no-drag relative flex flex-1 flex-col gap-4 px-2 pt-1"
          aria-label="Primary"
        >
          {ind && (
            <span
              aria-hidden="true"
              className="nav-ind pointer-events-none absolute left-2 right-2 top-0 rounded-md bg-sidebar-accent"
              style={{ translate: `0 ${ind.y}px`, height: ind.h }}
            />
          )}
          <div className="space-y-0.5">
            <p className={cn('nav-h', collapsed && 'sr-only')}>On this machine</p>
            {LOCAL.map(item)}
          </div>
          <div className="space-y-0.5">
            <p className={cn('nav-h', collapsed && 'sr-only')}>Roadmap · not built yet</p>
            {collapsed && <hr className="mx-2 mb-1 border-sidebar-border" aria-hidden="true" />}
            {ROADMAP.map(item)}
          </div>
          <div className="mt-auto space-y-0.5 pb-1">
            {item({ id: 'settings', label: 'Settings', icon: Settings })}
          </div>
        </nav>
        <div
          className={cn(
            'no-drag flex items-center border-t py-1.5 text-[11px] text-muted-foreground',
            collapsed ? 'flex-col gap-1' : 'justify-between px-2 pl-3'
          )}
        >
          {!collapsed && <span className="whitespace-nowrap">Local-first · redacted</span>}
          <ThemeToggle />
          <button
            type="button"
            onClick={toggleSidebar}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-expanded={!collapsed}
            title={`${collapsed ? 'Expand' : 'Collapse'} sidebar (${MOD}B)`}
            className="press grid size-8 place-items-center rounded-md hover:bg-sidebar-accent hover:text-sidebar-foreground"
          >
            {collapsed ? (
              <PanelLeftOpen className="size-4" aria-hidden="true" />
            ) : (
              <PanelLeftClose className="size-4" aria-hidden="true" />
            )}
          </button>
        </div>
      </aside>
      <div className="hairline relative flex min-w-0 flex-1 flex-col">
        <main className="min-h-0 min-w-0 flex-1 overflow-hidden" key={page}>
          <div className="enter h-full">
            {page === 'workspace' && <WorkspacePage />}
            {page === 'receipt' && <ReceiptPage />}
            {page === 'sync' && (
              <PlannedPage
                title="Platform sync, human-approved"
                blurb="A receipt becomes a plan, you read it, you approve it here. Only then would anything land on a platform. This build has no write path at all: nothing is sent anywhere."
                points={[
                  'GitHub Actions',
                  'Vercel',
                  'Railway',
                  'Render',
                  'Dokploy',
                  'Coolify',
                  'AWS Secrets Manager',
                  'HashiCorp Vault KV v2'
                ]}
                today="Dry-run plans already work from the Receipt page. They are descriptive only."
              />
            )}
            {page === 'share' && (
              <PlannedPage
                title="Share links instead of Slack"
                blurb="Hand off a file with a link that expires by time or view count, sealed on this device before it leaves and revocable from the app. Needs a small relay, which does not exist yet."
                points={[
                  'Sealed on device before upload',
                  'Expiry by time or open count',
                  'Revoke from the app',
                  'Recipient decrypts in the browser, no account'
                ]}
              />
            )}
            {page === 'history' && (
              <PlannedPage
                title="Local history and audit trail"
                blurb="Every change and every approved sync recorded on this machine. This build keeps nothing between launches: no database, no snapshots."
                points={[
                  'Per-file change log',
                  'Approved sync records',
                  'Roll back a file to a previous state'
                ]}
              />
            )}
            {page === 'agents' && (
              <PlannedPage
                title="MCP for coding agents"
                blurb="A local MCP server for Claude Code, Cursor and any MCP client: mismatch context and dry-run plans. Never values, never a sync. The context shape exists in code; the server does not."
                points={[
                  'Key names and mismatch classes',
                  'Dry-run plans',
                  'No values, ever',
                  'Cannot execute a sync'
                ]}
              />
            )}
            {page === 'settings' && <SettingsPage />}
          </div>
        </main>
        <StatusBar />
      </div>
    </div>
  )
}
