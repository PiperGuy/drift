import type { DriftStatus } from '@shared/drift'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

const TONE: Record<DriftStatus, string> = {
  same: 'border-ok/40 text-ok',
  changed: 'border-warn/40 text-warn',
  missing: 'border-bad/40 text-bad',
  extra: 'border-warn/40 text-warn',
  blank: 'border-muted-foreground/40 text-muted-foreground',
  ignored: 'border-border text-muted-foreground'
}

export function StatusBadge({ status }: { status: DriftStatus }): React.JSX.Element {
  return (
    <Badge
      variant="outline"
      className={cn('font-mono text-[11px] uppercase tracking-wide', TONE[status])}
    >
      {status}
    </Badge>
  )
}
