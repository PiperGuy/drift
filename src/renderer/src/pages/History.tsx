import { useEffect, useState, type CSSProperties } from 'react'
import { FolderOpen, GitCompareArrows, ScanSearch, Trash2, type LucideIcon } from 'lucide-react'
import type { HistoryEvent, HistoryKind } from '@shared/channels'
import { fmtAgo } from '@/lib/format'
import { useWorkspace } from '@/store/workspace'
import { cn } from '@/lib/utils'

const KIND: Record<HistoryKind, { icon: LucideIcon; label: string; tone: string }> = {
  grant: { icon: FolderOpen, label: 'Granted', tone: 'text-lemon-ink bg-lemon-soft' },
  scan: { icon: ScanSearch, label: 'Scanned', tone: 'text-foreground bg-muted' },
  compare: { icon: GitCompareArrows, label: 'Compared', tone: 'text-warn bg-warn-soft' },
  forget: { icon: Trash2, label: 'Forgot', tone: 'text-bad bg-bad-soft' }
}

const base = (p: unknown): string =>
  typeof p === 'string' ? p.split(/[\\/]/).slice(-2).join('/') : ''

function describe(e: HistoryEvent): string {
  switch (e.kind) {
    case 'grant':
      return String(e.subject['root'] ?? '')
    case 'scan':
      return `${e.detail['files'] ?? 0} files in ${e.detail['projects'] ?? 0} projects · ${base(e.subject['root'])}`
    case 'compare': {
      const d = e.detail
      const review =
        Number(d['changed'] ?? 0) +
        Number(d['missing'] ?? 0) +
        Number(d['extra'] ?? 0) +
        Number(d['blank'] ?? 0)
      return `${base(e.subject['left'])} → ${base(e.subject['right'])} · ${d['clean'] ? 'clean' : `${review} to review`}`
    }
    case 'forget':
      return 'Workspace, receipts and history cleared'
  }
}

/** Append-only, redacted. Every row is a path, a key count or a class; never a value. */
export function HistoryPage(): React.JSX.Element {
  const [events, setEvents] = useState<HistoryEvent[] | null>(null)
  // Re-read whenever a receipt or scan lands so the page is live while open.
  const receipt = useWorkspace((s) => s.receipt)
  const scan = useWorkspace((s) => s.scan)
  useEffect(() => {
    window.plumbr.listHistory().then(setEvents)
  }, [receipt, scan])

  return (
    <div className="flex h-full flex-col">
      <header className="glow flex h-14 shrink-0 items-center gap-3 border-b px-5">
        <div className="min-w-0 flex-1">
          <h1 className="text-base font-semibold tracking-tight">History</h1>
          <p className="font-mono text-[11px] text-muted-foreground">
            {events ? `${events.length} events on this machine` : '…'}
          </p>
        </div>
      </header>
      {events && events.length === 0 ? (
        <div className="dotgrid flex flex-1 items-center justify-center p-8">
          <div className="elev max-w-md rounded-lg border bg-card p-6 text-center">
            <p className="text-sm font-medium">Nothing recorded yet</p>
            <p className="mt-1.5 text-xs text-muted-foreground">
              Grants, scans and comparisons are logged here, redacted. Approved syncs and rollbacks
              will join them when those exist.
            </p>
          </div>
        </div>
      ) : (
        <ol className="stagger min-h-0 flex-1 overflow-auto" aria-label="Events">
          {events?.map((e, i) => {
            const k = KIND[e.kind]
            return (
              <li
                key={e.id}
                style={{ '--i': i } as CSSProperties}
                className="flex items-center gap-3 border-b px-5 py-2.5 text-sm"
              >
                <span className={cn('grid size-7 shrink-0 place-items-center rounded-md', k.tone)}>
                  <k.icon className="size-3.5" aria-hidden="true" />
                </span>
                <span className="w-20 shrink-0 text-[13px] font-medium">{k.label}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
                  {describe(e)}
                </span>
                <time
                  dateTime={new Date(e.at).toISOString()}
                  title={new Date(e.at).toLocaleString()}
                  className="shrink-0 font-mono text-[11px] text-muted-foreground"
                >
                  {fmtAgo(e.at)}
                </time>
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}
