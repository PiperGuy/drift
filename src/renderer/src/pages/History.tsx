import { useEffect, useState, type CSSProperties } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { fmtSize } from '@/lib/format'
import {
  Bot,
  Eraser,
  Eye,
  PenLine,
  Sparkles,
  Undo2,
  FolderOpen,
  GitCompareArrows,
  KeyRound,
  ScanSearch,
  Trash2,
  type LucideIcon
} from 'lucide-react'
import type { HistoryEvent, HistoryKind, Snapshot } from '@shared/channels'
import { fmtAgo } from '@/lib/format'
import { useWorkspace } from '@/store/workspace'
import { cn } from '@/lib/utils'

const KIND: Record<HistoryKind, { icon: LucideIcon; label: string; tone: string }> = {
  grant: { icon: FolderOpen, label: 'Granted', tone: 'text-lemon-ink bg-lemon-soft' },
  revoke: { icon: FolderOpen, label: 'Removed', tone: 'text-muted-foreground bg-muted' },
  workspace: { icon: FolderOpen, label: 'Workspace', tone: 'text-muted-foreground bg-muted' },
  scan: { icon: ScanSearch, label: 'Scanned', tone: 'text-foreground bg-muted' },
  compare: { icon: GitCompareArrows, label: 'Compared', tone: 'text-warn bg-warn-soft' },
  forget: { icon: Trash2, label: 'Forgot', tone: 'text-bad bg-bad-soft' },
  clear: { icon: Eraser, label: 'Cleared', tone: 'text-muted-foreground bg-muted' },
  license: { icon: KeyRound, label: 'Licensed', tone: 'text-ok bg-ok-soft' },
  mcp_install: { icon: Bot, label: 'MCP added', tone: 'text-lemon-ink bg-lemon-soft' },
  mcp_uninstall: { icon: Bot, label: 'MCP removed', tone: 'text-muted-foreground bg-muted' },
  reveal: { icon: Eye, label: 'Revealed', tone: 'text-bad bg-bad-soft' },
  apply: { icon: PenLine, label: 'Wrote', tone: 'text-lemon-ink bg-lemon-soft' },
  rollback: { icon: Undo2, label: 'Rolled back', tone: 'text-warn bg-warn-soft' },
  format: { icon: Sparkles, label: 'Formatted', tone: 'text-lemon-ink bg-lemon-soft' },
  edit: { icon: PenLine, label: 'Edited', tone: 'text-lemon-ink bg-lemon-soft' }
}

const base = (p: unknown): string =>
  typeof p === 'string' ? p.split(/[\\/]/).slice(-2).join('/') : ''

function describe(e: HistoryEvent): string {
  switch (e.kind) {
    case 'grant':
    case 'revoke':
      return String(e.subject['root'] ?? '')
    case 'workspace':
      return `${e.subject['action']} ${e.subject['name'] ?? ''}`
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
    case 'clear':
      return 'Receipts and history cleared'
    case 'license':
      return `Key activated${e.subject['name'] ? ` for ${e.subject['name']}` : ''}`
    case 'mcp_install':
    case 'mcp_uninstall':
      return String(e.subject['client'] ?? '')
    case 'reveal':
      return e.subject['key'] === '*'
        ? `all ${e.detail['keys']} keys in ${base(e.subject['path'])} · ${e.detail['method']}`
        : `${e.subject['key']} in ${base(e.subject['path'])} · ${e.detail['method']}`
    case 'apply': {
      const w = (e.detail['written'] as string[] | undefined) ?? []
      return `${w.length} key${w.length === 1 ? '' : 's'} → ${base(e.subject['right'])} · ${w.join(', ')}`
    }
    case 'rollback':
      return `${base(e.subject['path'])} restored from snapshot #${e.subject['snapshot']}`
    case 'format':
      return `${base(e.subject['path'])} · ${e.detail['changed']} lines tidied`
    case 'edit': {
      const w = (e.detail['written'] as string[] | undefined) ?? []
      return `${base(e.subject['path'])} · ${w.join(', ')}`
    }
  }
}

/** Append-only, redacted. Every row is a path, a key count or a class; never a value. */
export function HistoryPage(): React.JSX.Element {
  const [events, setEvents] = useState<HistoryEvent[] | null>(null)
  const [snaps, setSnaps] = useState<Snapshot[]>([])
  const [tab, setTab] = useState<'events' | 'snapshots'>('events')
  const [busy, setBusy] = useState<number | null>(null)
  const written = useWorkspace((s) => s.written)
  // Re-read whenever a receipt or scan lands so the page is live while open.
  const receipt = useWorkspace((s) => s.receipt)
  const scan = useWorkspace((s) => s.scan)
  const load = (): void => {
    window.plumbr.listHistory().then(setEvents)
    window.plumbr.listSnapshots().then(setSnaps)
  }
  useEffect(load, [receipt, scan, written])

  const restore = async (s: Snapshot): Promise<void> => {
    if (
      !window.confirm(
        `Restore ${s.path} to how it was ${fmtAgo(s.at)}? The current file is snapshotted first.`
      )
    )
      return
    setBusy(s.id)
    try {
      await window.plumbr.rollback(s.id)
      toast.success(`Restored ${s.path.split(/[\\/]/).pop()}`, {
        description: 'Rescan to refresh counts.'
      })
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message.replace(/^.*Error: /, '') : String(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b px-5">
        <div className="min-w-0 flex-1">
          <h1 className="text-base font-semibold tracking-tight">History</h1>
          <p className="font-mono text-[11px] text-muted-foreground">
            {events ? `${events.length} events · ${snaps.length} snapshots on this machine` : '…'}
          </p>
        </div>
        <div role="tablist" aria-label="View" className="inline-flex rounded-md border p-0.5">
          {(['events', 'snapshots'] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={cn(
                'h-7 rounded-sm px-3 text-xs capitalize transition-colors duration-(--duration-fast)',
                tab === t ? 'bg-accent font-medium' : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {t}
            </button>
          ))}
        </div>
      </header>
      {tab === 'snapshots' ? (
        snaps.length === 0 ? (
          <div className="dotgrid flex flex-1 items-center justify-center p-8">
            <div className="elev max-w-md rounded-lg border bg-card p-6 text-center">
              <p className="text-sm font-medium">No snapshots yet</p>
              <p className="mt-1.5 text-xs text-muted-foreground">
                Every approved write and every rollback stores the file as it was just before,
                sealed by the OS keyring. Restore any of them from here.
              </p>
            </div>
          </div>
        ) : (
          <ol className="stagger min-h-0 flex-1 overflow-auto" aria-label="Snapshots">
            {snaps.map((s, i) => (
              <li
                key={s.id}
                style={{ '--i': i } as CSSProperties}
                className="flex items-center gap-3 border-b px-5 py-2.5 text-sm"
              >
                <span className="grid size-7 shrink-0 place-items-center rounded-md bg-muted text-foreground">
                  {s.reason === 'apply' ? (
                    <PenLine className="size-3.5" />
                  ) : (
                    <Undo2 className="size-3.5" />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-xs" title={s.path}>
                    {base(s.path)}
                  </p>
                  <p className="font-mono text-[11px] text-muted-foreground">
                    before {s.reason} · {s.keys.length} keys · {fmtSize(s.size)}
                    {!s.restorable && ' · shape only, not restorable'}
                  </p>
                </div>
                <time
                  dateTime={new Date(s.at).toISOString()}
                  className="shrink-0 font-mono text-[11px] text-muted-foreground"
                >
                  {fmtAgo(s.at)}
                </time>
                <Button
                  size="xs"
                  variant="outline"
                  className="press"
                  disabled={!s.restorable || busy !== null}
                  onClick={() => restore(s)}
                >
                  <Undo2 /> Restore
                </Button>
              </li>
            ))}
          </ol>
        )
      ) : null}
      {tab === 'events' && events && events.length === 0 ? (
        <div className="dotgrid flex flex-1 items-center justify-center p-8">
          <div className="elev max-w-md rounded-lg border bg-card p-6 text-center">
            <p className="text-sm font-medium">Nothing recorded yet</p>
            <p className="mt-1.5 text-xs text-muted-foreground">
              Grants, scans and comparisons are logged here, redacted. Approved syncs and rollbacks
              will join them when those exist.
            </p>
          </div>
        </div>
      ) : tab === 'events' ? (
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
      ) : null}
    </div>
  )
}
