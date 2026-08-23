import { useEffect, useState } from 'react'
import { Copy, Check, Eye, EyeOff, Fingerprint, X } from 'lucide-react'
import type { EnvFileInfo } from '@shared/channels'
import type { KeySummary } from '@/store/workspace'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

const HIDE_AFTER_MS = 20_000

/**
 * Every key of one file, redacted. The eye asks main for one value behind OS
 * authentication; it is shown for 20 seconds, never stored in the renderer
 * beyond that, and the reveal is logged by key name only.
 */
export function KeysPanel({
  file,
  summary,
  onClose
}: {
  file: EnvFileInfo
  summary: KeySummary | undefined
  onClose: () => void
}): React.JSX.Element {
  const [shown, setShown] = useState<{ key: string; value: string | null; method: string } | null>(
    null
  )
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!shown) return
    const t = setTimeout(() => setShown(null), HIDE_AFTER_MS)
    return () => clearTimeout(t)
  }, [shown])

  const reveal = async (key: string): Promise<void> => {
    setBusy(key)
    setError(null)
    try {
      const r = await window.plumbr.revealValue({ path: file.path, key })
      setShown({ key, value: r.value, method: r.method })
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^.*Error: /, '') : String(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <aside
      className="enter flex min-h-0 w-72 shrink-0 flex-col border-l bg-card"
      aria-label={`Keys in ${file.rel}`}
    >
      <header className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={file.rel}>
          {file.rel}
        </span>
        <span className="font-mono text-[11px] text-muted-foreground">{summary?.keys ?? '…'}</span>
        <Button size="icon-xs" variant="ghost" aria-label="Close keys" onClick={onClose}>
          <X />
        </Button>
      </header>
      {error && (
        <p role="alert" className="border-b bg-bad-soft px-3 py-1.5 text-xs text-bad">
          {error}
        </p>
      )}
      <ul className="stagger min-h-0 flex-1 overflow-auto" aria-label="Keys">
        {summary?.names.map((k, i) => {
          const open = shown?.key === k.key
          return (
            <li
              key={k.key}
              style={{ '--i': i } as React.CSSProperties}
              className={cn('border-b px-3 py-2', open && 'bg-lemon-soft/60')}
            >
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{k.key}</span>
                {k.blank ? (
                  <span className="font-mono text-[10px] text-muted-foreground">blank</span>
                ) : open ? (
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Hide ${k.key}`}
                    onClick={() => setShown(null)}
                  >
                    <EyeOff />
                  </Button>
                ) : (
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Reveal ${k.key}`}
                    disabled={busy !== null}
                    onClick={() => reveal(k.key)}
                  >
                    {busy === k.key ? <Fingerprint className="animate-pulse" /> : <Eye />}
                  </Button>
                )}
              </div>
              {open ? (
                <div className="mt-1.5 flex items-center gap-1.5">
                  <code className="min-w-0 flex-1 rounded-sm bg-background px-1.5 py-1 font-mono text-[11px] break-all select-text">
                    {shown.value ?? '(not in file)'}
                  </code>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label="Copy value"
                    disabled={shown.value === null}
                    onClick={async () => {
                      await navigator.clipboard.writeText(shown.value ?? '')
                      setCopied(true)
                      setTimeout(() => setCopied(false), 1200)
                    }}
                  >
                    {copied ? <Check className="text-ok" /> : <Copy />}
                  </Button>
                </div>
              ) : (
                !k.blank && (
                  <p
                    className="mt-1 font-mono text-[11px] tracking-[0.3em] text-muted-foreground"
                    aria-hidden="true"
                  >
                    ••••••••
                  </p>
                )
              )}
            </li>
          )
        })}
      </ul>
      <p className="shrink-0 border-t px-3 py-2 text-[10px] leading-relaxed text-muted-foreground">
        Reveal asks the OS to confirm it is you (Touch ID on macOS, polkit on Linux, a confirm
        dialog on Windows). Shown for 20 s, logged by key name only.
      </p>
    </aside>
  )
}
