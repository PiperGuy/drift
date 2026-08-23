import { useState } from 'react'
import { ArrowRight, Loader2, PenLine, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import type { EnvFileInfo } from '@shared/channels'
import type { SyncAction } from '@shared/drift'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useWorkspace } from '@/store/workspace'
import { cn } from '@/lib/utils'

const OP: Record<SyncAction['op'], { glyph: string; tone: string; on: boolean }> = {
  add: { glyph: '+', tone: 'text-ok', on: true },
  update: { glyph: '~', tone: 'text-warn', on: true },
  review: { glyph: '?', tone: 'text-bad', on: false },
  keep: { glyph: '=', tone: 'text-muted-foreground', on: false }
}

/**
 * The approval step: the exact keys, the exact file, nothing else. Add and update
 * are pre-checked; review keys are opt-in. Extra keys on the target are never touched.
 */
export function ApplyDialog({
  open,
  onOpenChange,
  left,
  right,
  plan
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  left: EnvFileInfo
  right: EnvFileInfo
  plan: SyncAction[]
}): React.JSX.Element {
  const candidates = plan.filter((a) => a.op !== 'keep')
  const [chosen, setChosen] = useState<Set<string>>(
    () => new Set(candidates.filter((a) => OP[a.op].on).map((a) => a.key))
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { rescan, compare, noteWritten } = useWorkspace()

  const toggle = (k: string): void =>
    setChosen((s) => {
      const n = new Set(s)
      if (n.has(k)) n.delete(k)
      else n.add(k)
      return n
    })

  const apply = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const r = await window.plumbr.applyPlan({
        left: left.path,
        right: right.path,
        keys: [...chosen],
        expectedMtime: right.modifiedAt
      })
      noteWritten(r.written.length)
      toast.success(
        `Wrote ${r.written.length} key${r.written.length === 1 ? '' : 's'} to ${right.rel}`,
        {
          description: r.skipped.length
            ? `Skipped ${r.skipped.map((s) => `${s.key} (${s.reason})`).join(', ')}`
            : 'Snapshot taken first. Roll back from History.'
        }
      )
      onOpenChange(false)
      // Files changed on disk: refresh metadata, then the receipt.
      await rescan()
      await compare()
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^.*Error: /, '') : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PenLine className="size-4 text-lemon-ink" /> Write to {right.rel}
          </DialogTitle>
          <DialogDescription className="flex items-center gap-1.5 font-mono text-xs">
            <span className="truncate">{left.rel}</span>
            <ArrowRight className="size-3 shrink-0" />
            <span className="truncate">{right.rel}</span>
          </DialogDescription>
        </DialogHeader>

        <ul
          className="max-h-72 divide-y overflow-auto rounded-md border"
          aria-label="Keys to write"
        >
          {candidates.map((a) => {
            const on = chosen.has(a.key)
            return (
              <li key={a.key}>
                <label
                  className={cn(
                    'flex cursor-pointer items-center gap-3 px-3 py-2 text-sm',
                    on && 'bg-lemon-soft/50'
                  )}
                >
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => toggle(a.key)}
                    className="accent-(--lemon-ink)"
                  />
                  <span className={cn('w-4 font-mono text-xs', OP[a.op].tone)} aria-hidden="true">
                    {OP[a.op].glyph}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">{a.key}</span>
                  <span className="font-mono text-[11px] text-muted-foreground">{a.op}</span>
                </label>
              </li>
            )
          })}
          {candidates.length === 0 && (
            <li className="px-3 py-4 text-center text-xs text-muted-foreground">
              Nothing to write.
            </li>
          )}
        </ul>

        <p className="flex items-start gap-2 text-xs text-muted-foreground">
          <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-lemon-ink" aria-hidden="true" />
          <span>
            Each chosen key&apos;s assignment is copied from {left.name} as written there. The file
            is snapshotted first, written atomically, and refused if it changed since this plan.
            Keys only in {right.name} are never removed. Comments and order stay as they are.
          </span>
        </p>
        {error && (
          <p
            role="alert"
            className="rounded-md border border-bad/30 bg-bad-soft px-3 py-2 text-xs text-bad"
          >
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button className="press" onClick={apply} disabled={busy || chosen.size === 0}>
            {busy ? <Loader2 className="animate-spin motion-reduce:animate-none" /> : <PenLine />}
            Write {chosen.size} key{chosen.size === 1 ? '' : 's'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
