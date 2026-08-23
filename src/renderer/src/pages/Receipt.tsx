import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { ArrowRight, ArrowRightLeft, PenLine, RefreshCw, Search, X } from 'lucide-react'
import { planSync, type DriftStatus, type SyncAction } from '@shared/drift'
import {
  DEFAULT_VIEW,
  STATUS_ORDER,
  filterPlan,
  filterRows,
  toggleStatus,
  type ReceiptView
} from '@shared/receipt-view'
import { StatusBadge } from '@/components/app/StatusBadge'
import { STATUS_META } from '@/lib/status'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { DEFAULT_IGNORE, useWorkspace } from '@/store/workspace'
import { cn } from '@/lib/utils'
import { ApplyDialog } from '@/components/app/ApplyDialog'

const OP_META: Record<SyncAction['op'], { glyph: string; tone: string }> = {
  add: { glyph: '+', tone: 'text-ok' },
  update: { glyph: '~', tone: 'text-warn' },
  review: { glyph: '?', tone: 'text-bad' },
  keep: { glyph: '=', tone: 'text-muted-foreground' }
}

function Empty({ onWorkspace }: { onWorkspace: () => void }): React.JSX.Element {
  return (
    <div className="dotgrid flex h-full items-center justify-center p-8">
      <div className="elev max-w-md rounded-lg border bg-card p-6 text-center">
        <h1 className="text-base font-semibold tracking-tight">No pair selected</h1>
        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
          In Workspace, mark one file as A (source) and another as B (target). The receipt lists
          every key with a class: same, changed, missing, extra, blank or ignored. Values are
          compared as fingerprints on this machine and never shown.
        </p>
        <Button className="mt-4" variant="outline" size="sm" onClick={onWorkspace}>
          Go to Workspace
        </Button>
      </div>
    </div>
  )
}

export function ReceiptPage(): React.JSX.Element {
  const { left, right, receipt, comparing, compare, swap, error, setPage } = useWorkspace()
  const [view, setView] = useState<ReceiptView>(DEFAULT_VIEW)
  const [tab, setTab] = useState<'receipt' | 'plan'>('receipt')
  const [applying, setApplying] = useState(false)
  const search = useRef<HTMLInputElement>(null)

  // A fresh pair has no receipt yet: run the comparison once, on real files.
  useEffect(() => {
    if (left && right && !receipt && !comparing && !error) void compare()
  }, [left, right, receipt, comparing, error, compare])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        search.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const rows = useMemo(() => (receipt ? filterRows(receipt.rows, view) : []), [receipt, view])
  const plan = useMemo(() => (receipt ? planSync(receipt) : []), [receipt])
  // Status chips apply to the plan too: an action is shown only if its key survives the receipt filter.
  const planRows = useMemo(() => {
    const keep = new Set(rows.map((r) => r.key))
    return filterPlan(plan, view.query).filter((a) => keep.has(a.key))
  }, [plan, rows, view.query])

  if (!left || !right) return <Empty onWorkspace={() => setPage('workspace')} />

  const review = receipt
    ? receipt.counts.changed + receipt.counts.missing + receipt.counts.extra + receipt.counts.blank
    : 0

  return (
    <div className="flex h-full flex-col">
      <header className="glow flex h-14 shrink-0 items-center gap-3 border-b px-5">
        <div className="min-w-0 flex-1">
          <h1 className="text-base font-semibold tracking-tight">Drift receipt</h1>
          <p className="flex min-w-0 items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
            <span className="rounded-sm bg-primary px-1 font-semibold text-primary-foreground">
              A
            </span>
            <span className="truncate" title={left.rel}>
              {left.rel}
            </span>
            <ArrowRight className="size-3 shrink-0" aria-label="to" />
            <span className="rounded-sm bg-primary px-1 font-semibold text-primary-foreground">
              B
            </span>
            <span className="truncate" title={right.rel}>
              {right.rel}
            </span>
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={swap} aria-label="Swap A and B">
          <ArrowRightLeft /> Swap
        </Button>
        <Button size="sm" className="press" onClick={compare} disabled={comparing}>
          <RefreshCw className={cn(comparing && 'animate-spin motion-reduce:animate-none')} />
          {comparing ? 'Comparing' : receipt ? 'Compare again' : 'Compare'}
        </Button>
      </header>

      {error && (
        <p role="alert" className="border-b bg-bad-soft px-4 py-2 text-xs text-bad">
          {error}
        </p>
      )}

      {receipt && (
        <>
          <div
            className="flex flex-wrap items-stretch gap-2 border-b px-5 py-4"
            role="group"
            aria-label="Summary"
          >
            <div
              key={`${left.path}→${right.path}:${receipt.rows.length}`}
              className={cn(
                'stamp elev flex min-w-36 flex-col justify-center rounded-lg border px-4 py-2',
                receipt.clean ? 'border-ok/30 bg-ok-soft' : 'border-warn/30 bg-warn-soft'
              )}
            >
              <span
                className={cn(
                  'numeral text-3xl leading-none',
                  receipt.clean ? 'text-ok' : 'tally text-warn'
                )}
                style={receipt.clean ? undefined : ({ '--n': review } as CSSProperties)}
              >
                {receipt.clean ? '✓' : <span className="sr-only">{review}</span>}
              </span>
              <span className="mt-1 text-[11px] text-muted-foreground">
                {receipt.clean
                  ? 'clean, nothing to review'
                  : review === 1
                    ? 'key to review'
                    : 'keys to review'}
              </span>
            </div>
            {STATUS_ORDER.map((s: DriftStatus) => {
              const on = view.statuses.has(s)
              const n = receipt.counts[s]
              return (
                <button
                  key={s}
                  type="button"
                  aria-pressed={on}
                  disabled={n === 0}
                  title={STATUS_META[s].hint}
                  onClick={() => setView((v) => ({ ...v, statuses: toggleStatus(v.statuses, s) }))}
                  className={cn(
                    'press elev flex min-w-22 flex-col justify-center rounded-lg border bg-card px-3 py-2 text-left transition-colors duration-(--duration-fast) disabled:opacity-40',
                    on ? 'border-lemon-ink/40 bg-lemon-soft' : 'border-border hover:bg-accent/50'
                  )}
                >
                  <span
                    className="tally numeral text-2xl leading-none"
                    style={{ '--n': n } as CSSProperties}
                  >
                    <span className="sr-only">{n}</span>
                  </span>
                  <span className="mt-1 text-[11px] text-muted-foreground">
                    <span aria-hidden="true">{STATUS_META[s].glyph} </span>
                    {s}
                  </span>
                </button>
              )
            })}
          </div>

          <div className="flex shrink-0 items-center gap-2 border-b px-5 py-2">
            <div role="tablist" aria-label="View" className="inline-flex rounded-md border p-0.5">
              {(['receipt', 'plan'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  aria-selected={tab === t}
                  onClick={() => setTab(t)}
                  className={cn(
                    'h-7 rounded-sm px-3 text-xs transition-colors duration-(--duration-fast)',
                    tab === t
                      ? 'bg-accent font-medium'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  {t === 'receipt'
                    ? `Receipt · ${receipt.rows.length}`
                    : `Dry-run plan · ${plan.length}`}
                </button>
              ))}
            </div>
            <div className="relative ml-auto w-48">
              <Search
                className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                ref={search}
                aria-label="Search keys"
                placeholder="Search keys"
                value={view.query}
                onChange={(e) => setView((v) => ({ ...v, query: e.target.value }))}
                className="h-7 pl-7 font-mono text-xs"
              />
              {view.query && (
                <button
                  type="button"
                  aria-label="Clear search"
                  onClick={() => setView((v) => ({ ...v, query: '' }))}
                  className="absolute top-1/2 right-1.5 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  <X className="size-3.5" />
                </button>
              )}
            </div>
            {tab === 'plan' && plan.some((a) => a.op !== 'keep') && (
              <Button size="sm" className="press h-7 text-xs" onClick={() => setApplying(true)}>
                <PenLine /> Apply to B…
              </Button>
            )}
            {tab === 'receipt' && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={() =>
                  setView((v) => ({ ...v, sort: v.sort === 'status' ? 'key' : 'status' }))
                }
              >
                Sort: {view.sort}
              </Button>
            )}
          </div>

          <div className="ledger min-h-0 flex-1 overflow-auto" key={tab}>
            {tab === 'receipt' ? (
              <table className="enter w-full text-sm">
                <thead className="sticky top-0 z-10 bg-background text-[11px] text-muted-foreground">
                  <tr className="border-b [&>th]:h-9 [&>th]:px-5 [&>th]:text-left [&>th]:font-medium [&>th]:tracking-wide [&>th]:uppercase">
                    <th>Key</th>
                    <th className="w-32">Class</th>
                    <th className="hidden md:table-cell">Meaning</th>
                  </tr>
                </thead>
                <tbody className="stagger" key={[...view.statuses].join() + view.sort}>
                  {rows.map((r, i) => (
                    <tr
                      key={r.key}
                      style={{ '--i': i } as CSSProperties}
                      className="h-8 border-b border-transparent [&>td]:px-5"
                    >
                      <td className="font-mono text-xs">{r.key}</td>
                      <td>
                        <StatusBadge status={r.status} />
                      </td>
                      <td className="hidden text-xs text-muted-foreground md:table-cell">
                        {STATUS_META[r.status].hint}
                      </td>
                    </tr>
                  ))}
                  {rows.length === 0 && (
                    <tr>
                      <td
                        colSpan={3}
                        className="h-16 px-4 text-center text-xs text-muted-foreground"
                      >
                        No keys match.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            ) : (
              <table className="enter w-full text-sm">
                <thead className="sticky top-0 z-10 bg-background text-[11px] text-muted-foreground">
                  <tr className="border-b [&>th]:h-9 [&>th]:px-5 [&>th]:text-left [&>th]:font-medium [&>th]:tracking-wide [&>th]:uppercase">
                    <th>Key</th>
                    <th className="w-28">Would</th>
                    <th>Because</th>
                  </tr>
                </thead>
                <tbody className="stagger">
                  {planRows.map((a, i) => (
                    <tr
                      key={a.key}
                      style={{ '--i': i } as CSSProperties}
                      className="h-8 border-b border-transparent [&>td]:px-5"
                    >
                      <td className="font-mono text-xs">{a.key}</td>
                      <td className={cn('font-mono text-xs uppercase', OP_META[a.op].tone)}>
                        <span aria-hidden="true">{OP_META[a.op].glyph} </span>
                        {a.op}
                      </td>
                      <td className="text-xs text-muted-foreground">{a.reason}</td>
                    </tr>
                  ))}
                  {planRows.length === 0 && (
                    <tr>
                      <td
                        colSpan={3}
                        className="h-16 px-4 text-center text-xs text-muted-foreground"
                      >
                        {plan.length === 0
                          ? 'Nothing to do: B already matches A.'
                          : 'No keys match.'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            )}
          </div>

          <p className="shrink-0 border-t bg-card px-5 py-2 text-[11px] text-muted-foreground">
            Nothing is written until you approve an exact list of keys from the plan tab. B is
            snapshotted first and can be rolled back from History. Extra keys on B are never
            removed. Nothing is sent anywhere. Ignored:{' '}
            <code className="font-mono">{DEFAULT_IGNORE.join(', ')}</code>.
          </p>
          {applying && (
            <ApplyDialog open onOpenChange={setApplying} left={left} right={right} plan={plan} />
          )}
        </>
      )}
    </div>
  )
}
