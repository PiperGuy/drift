import { Lock, WifiOff } from 'lucide-react'
import { useWorkspace } from '@/store/workspace'

/**
 * One honest line at the bottom of the window: what is granted, what was found,
 * and the guarantees this build actually enforces (no writes, no network).
 */
export function StatusBar(): React.JSX.Element {
  const root = useWorkspace((s) => s.root)
  const scan = useWorkspace((s) => s.scan)
  const scanning = useWorkspace((s) => s.scanning)
  return (
    <footer
      className="flex h-7 shrink-0 items-center gap-4 border-t bg-sidebar px-3 font-mono text-[11px] text-muted-foreground"
      aria-label="Status"
    >
      <span className="min-w-0 flex-1 truncate" title={root ?? undefined}>
        {root
          ? scanning
            ? `scanning ${root}…`
            : `${root} · ${scan?.files.length ?? 0} files · ${scan?.projects.length ?? 0} projects`
          : 'no workspace granted'}
      </span>
      <span
        className="hidden items-center gap-1 sm:inline-flex"
        title="Values never leave the main process"
      >
        <Lock className="size-3" aria-hidden="true" /> values redacted
      </span>
      <span
        className="inline-flex items-center gap-1"
        title="This build has no network or write path"
      >
        <WifiOff className="size-3" aria-hidden="true" /> 0 written · 0 sent
      </span>
    </footer>
  )
}
