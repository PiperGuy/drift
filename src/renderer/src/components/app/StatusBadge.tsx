import type { DriftStatus } from '@shared/drift'
import { STATUS_META } from '@/lib/status'
import { cn } from '@/lib/utils'

export function StatusBadge({
  status,
  className
}: {
  status: DriftStatus
  className?: string
}): React.JSX.Element {
  const m = STATUS_META[status]
  return (
    <span
      title={m.hint}
      className={cn(
        'inline-flex h-5 items-center gap-1 rounded-sm border px-1.5 font-mono text-[11px] tracking-wide uppercase',
        m.tone,
        className
      )}
    >
      <span aria-hidden="true" className="w-2 text-center">
        {m.glyph}
      </span>
      {m.label}
    </span>
  )
}
