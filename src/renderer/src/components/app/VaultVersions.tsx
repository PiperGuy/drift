import { useEffect, useState } from 'react'
import { GitCompareArrows, History, Loader2, Undo2 } from 'lucide-react'
import { toast } from 'sonner'
import type { EnvFileInfo, VaultHistory, VaultVersionMeta } from '@shared/channels'
import { compareEnv, type DriftReceipt } from '@shared/drift'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { StatusBadge } from '@/components/app/StatusBadge'
import { fmtAgo } from '@/lib/format'
import { useWorkspace } from '@/store/workspace'
import { cn } from '@/lib/utils'
import { versionState, type VersionState } from '@/lib/status'

const err = (e: unknown): string =>
  e instanceof Error ? e.message.replace(/^.*Error: /, '') : String(e)

/** The state word is the cue; colour only reinforces it. */
export function VersionChip({ state }: { state: VersionState }): React.JSX.Element {
  return (
    <span
      className={cn(
        'shrink-0 rounded-sm px-1.5 py-0.5 font-mono text-[10px] uppercase',
        state === 'current' && 'bg-ok-soft text-ok',
        state === 'live' && 'bg-muted text-muted-foreground',
        state === 'deleted' && 'bg-warn-soft text-warn',
        state === 'destroyed' && 'bg-bad-soft text-bad'
      )}
    >
      {state}
    </span>
  )
}

/**
 * The version timeline of one Vault KV v2 environment: metadata only, straight
 * from Vault. Comparing a version fetches its redacted shape on demand and runs
 * the ordinary drift receipt against the current version — values never appear.
 * Restore writes vN's data as a NEW version, check-and-set-guarded on the
 * current one; nothing is undeleted or destroyed from here.
 */
export function VaultVersions({
  file,
  onClose
}: {
  file: EnvFileInfo
  onClose: () => void
}): React.JSX.Element {
  const [hist, setHist] = useState<VaultHistory | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<number | null>(null)
  const [receipt, setReceipt] = useState<{ version: number; receipt: DriftReceipt } | null>(null)
  const [reload, setReload] = useState(0)
  const rescan = useWorkspace((s) => s.rescan)
  const load = (): void => setReload((n) => n + 1)

  useEffect(() => {
    let live = true
    window.plumbr
      .vaultHistory(file.path)
      .then((h) => {
        if (live) {
          setHist(h)
          setError(null)
        }
      })
      .catch((e) => live && setError(err(e)))
    return () => {
      live = false
    }
  }, [file.path, reload])

  const compare = async (v: VaultVersionMeta): Promise<void> => {
    setBusy(v.version)
    setError(null)
    try {
      const [old, cur] = await Promise.all([
        window.plumbr.vaultShapeAt({ path: file.path, version: v.version }),
        window.plumbr.envShape({ path: file.path })
      ])
      setReceipt({ version: v.version, receipt: compareEnv(old, cur) })
    } catch (e) {
      setError(err(e))
    } finally {
      setBusy(null)
    }
  }

  const restore = async (v: VaultVersionMeta): Promise<void> => {
    if (!hist) return
    if (
      !window.confirm(
        `Write v${v.version}'s keys as a new version of ${file.name}? The current version (v${hist.currentVersion}) stays in the history.`
      )
    )
      return
    setBusy(v.version)
    setError(null)
    try {
      const r = await window.plumbr.vaultRestore({
        path: file.path,
        version: v.version,
        expectedVersion: hist.currentVersion
      })
      toast.success(`Restored ${file.name} from v${v.version}`, {
        description: r.version
          ? `Now v${r.version.next}${r.verified ? ' · verified by read-back' : ''}`
          : undefined
      })
      setReceipt(null)
      load()
      await rescan()
    } catch (e) {
      setError(err(e))
    } finally {
      setBusy(null)
    }
  }

  const state = (v: VaultVersionMeta): VersionState => versionState(v, hist?.currentVersion)

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <History className="size-4 text-lemon-ink" /> Vault versions · {file.name}
          </DialogTitle>
          <DialogDescription>
            Straight from Vault&apos;s metadata. Compare shows a redacted receipt against the
            current version; Restore writes an old version&apos;s keys as a new one.
          </DialogDescription>
        </DialogHeader>

        {error && (
          <p
            role="alert"
            className="rounded-md border border-bad/30 bg-bad-soft px-3 py-2 text-xs text-bad"
          >
            {error}
          </p>
        )}
        {!hist && !error && (
          <p className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" /> Reading
            metadata…
          </p>
        )}

        {hist && (
          <>
            <ol className="max-h-72 divide-y overflow-auto rounded-md border" aria-label="Versions">
              {hist.versions.map((v) => {
                const st = state(v)
                return (
                  <li key={v.version} className="flex items-center gap-3 px-3 py-2 text-sm">
                    <span className="w-10 shrink-0 font-mono text-xs">v{v.version}</span>
                    <VersionChip state={st} />
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
                      {v.createdTime ? fmtAgo(Date.parse(v.createdTime)) : ''}
                      {v.createdBy?.actor ? ` · by ${v.createdBy.actor}` : ''}
                      {v.createdBy?.operation ? ` (${v.createdBy.operation})` : ''}
                    </span>
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={busy !== null || st === 'deleted' || st === 'destroyed'}
                      title="Redacted receipt: this version vs the current one"
                      onClick={() => compare(v)}
                    >
                      {busy === v.version ? (
                        <Loader2 className="animate-spin motion-reduce:animate-none" />
                      ) : (
                        <GitCompareArrows />
                      )}
                      Compare
                    </Button>
                    <Button
                      size="xs"
                      variant="outline"
                      className="press"
                      disabled={busy !== null || st !== 'live'}
                      title="Write this version's keys as a new version (check-and-set guarded)"
                      onClick={() => restore(v)}
                    >
                      <Undo2 /> Restore
                    </Button>
                  </li>
                )
              })}
            </ol>
            <p className="text-[11px] text-muted-foreground">
              {hist.oldestVersion > 1 &&
                `v1–v${hist.oldestVersion - 1} rolled off (Vault keeps ${hist.maxVersions || 10} versions here). `}
              {hist.deleteVersionAfter !== '0s' &&
                `New versions on this path auto-delete after ${hist.deleteVersionAfter}. `}
              Deleted and destroyed versions cannot be read; restore only live ones.
            </p>

            {receipt && (
              <div className="rounded-md border">
                <p className="border-b px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
                  v{receipt.version} → current ·{' '}
                  {receipt.receipt.clean
                    ? 'identical'
                    : `${receipt.receipt.counts.changed} changed · ${receipt.receipt.counts.missing} removed since · ${receipt.receipt.counts.extra} added since · ${receipt.receipt.counts.blank} blank${receipt.receipt.counts.unknown ? ` · ${receipt.receipt.counts.unknown} unknown` : ''}`}
                </p>
                <ul className="max-h-40 divide-y overflow-auto">
                  {receipt.receipt.rows
                    .filter((r) => r.status !== 'same')
                    .map((r) => (
                      <li key={r.key} className="flex items-center gap-3 px-3 py-1">
                        <span className="min-w-0 flex-1 truncate font-mono text-xs">{r.key}</span>
                        <StatusBadge status={r.status} />
                      </li>
                    ))}
                  {receipt.receipt.clean && (
                    <li className="px-3 py-2 text-xs text-muted-foreground">
                      Every key matches the current version.
                    </li>
                  )}
                </ul>
              </div>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
