import type { RootKind } from '@shared/channels'
import { SOURCE_META } from '@/lib/sources'

/** Lucide icon or a simple-icons brand mark, sized like a lucide icon. */
export function SourceIcon({
  kind,
  className
}: {
  kind: RootKind
  className?: string
}): React.JSX.Element {
  const icon = SOURCE_META[kind].icon
  if ('path' in icon)
    return (
      <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
        <path d={icon.path} fill="currentColor" />
      </svg>
    )
  const Icon = icon
  return <Icon className={className} aria-hidden="true" />
}
