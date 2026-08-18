import { useState } from 'react'
import { Bot, FolderSearch, GitCompareArrows, History, Link2, Settings, Upload } from 'lucide-react'
import { Logo } from '@/components/app/Logo'
import { ThemeToggle } from '@/components/app/ThemeToggle'
import { Separator } from '@/components/ui/separator'
import { WorkspacePage } from '@/pages/Workspace'
import { ReceiptPage } from '@/pages/Receipt'
import { PlannedPage } from '@/pages/Planned'
import { SettingsPage } from '@/pages/Settings'
import { cn } from '@/lib/utils'

const NAV = [
  { id: 'workspace', label: 'Workspace', icon: FolderSearch },
  { id: 'receipt', label: 'Receipt', icon: GitCompareArrows },
  { id: 'sync', label: 'Sync', icon: Upload },
  { id: 'share', label: 'Share', icon: Link2 },
  { id: 'history', label: 'History', icon: History },
  { id: 'agents', label: 'Agents', icon: Bot },
  { id: 'settings', label: 'Settings', icon: Settings }
] as const
type PageId = (typeof NAV)[number]['id']

// ponytail: useState router. Move to TanStack Router when pages need deep links or params.
export default function App(): React.JSX.Element {
  const [page, setPage] = useState<PageId>('workspace')
  return (
    <div className="flex h-full">
      <aside className="drag flex w-56 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground">
        <div className="flex h-14 items-center gap-2 px-4 pt-1 pl-[max(1rem,env(titlebar-area-x,1rem))]">
          <Logo />
          <span className="text-sm font-semibold">Plumbr Env</span>
        </div>
        <nav className="no-drag flex flex-1 flex-col gap-0.5 px-2">
          {NAV.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setPage(id)}
              className={cn(
                'flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
                page === id
                  ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                  : 'text-muted-foreground hover:bg-sidebar-accent/60'
              )}
            >
              <Icon className="size-4" /> {label}
            </button>
          ))}
        </nav>
        <Separator />
        <div className="flex items-center justify-between p-2 pl-3 text-[11px] text-muted-foreground">
          <span>Local-first · redacted</span>
          <ThemeToggle />
        </div>
      </aside>
      <main className="min-w-0 flex-1 overflow-hidden">
        {page === 'workspace' && <WorkspacePage />}
        {page === 'receipt' && <ReceiptPage />}
        {page === 'sync' && (
          <PlannedPage
            title="Platform sync, human-approved"
            blurb="Turn a receipt into a dry-run plan, read it, approve it here. Only then does anything land on a platform."
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
          />
        )}
        {page === 'share' && (
          <PlannedPage
            title="Share links instead of Slack"
            blurb="Hand off a file with a link that expires by time or view count. Sealed on this device before it leaves, and revocable."
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
            blurb="Every change and every approved sync recorded on this machine, so you can see who changed what and roll back."
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
            blurb="A local MCP server for Claude Code, Cursor and any MCP client: mismatch context and dry-run plans. Never values, never a sync."
            points={[
              'Key names and mismatch classes',
              'Dry-run plans',
              'No values, ever',
              'Cannot execute a sync'
            ]}
          />
        )}
        {page === 'settings' && <SettingsPage />}
      </main>
    </div>
  )
}
