import { useEffect, useState, type CSSProperties } from 'react'
import {
  AlertTriangle,
  Check,
  CircleAlert,
  Copy,
  Eye,
  EyeOff,
  Fingerprint,
  Info,
  Loader2,
  Sparkles,
  X
} from 'lucide-react'
import { toast } from 'sonner'
import type { EnvFileInfo } from '@shared/channels'
import type { EnvView, LintIssue, Severity, ViewLine } from '@shared/env-lint'
import { Button } from '@/components/ui/button'
import { useWorkspace } from '@/store/workspace'
import { cn } from '@/lib/utils'

const HIDE_AFTER_MS = 20_000

/** A guess at what a key holds, from its name only. Decorative: never from the value. */
function kindOf(key: string): { label: string; tone: string } {
  if (/(SECRET|TOKEN|PASS(WORD)?|PRIVATE|_KEY$|API_?KEY|ACCESS_?KEY|CREDENTIAL|AUTH)/i.test(key))
    return { label: 'secret', tone: 'text-bad bg-bad-soft border-bad/20' }
  if (/(URL|URI|ENDPOINT|HOST|DSN)$/i.test(key))
    return { label: 'url', tone: 'text-lemon-ink bg-lemon-soft border-lemon-ink/20' }
  if (/(PORT|TIMEOUT|LIMIT|SIZE|COUNT|MAX|MIN)$/i.test(key))
    return { label: 'number', tone: 'text-foreground bg-muted border-border' }
  if (/^(ENABLE|DISABLE|USE|IS|HAS|DEBUG|FEATURE)/i.test(key) || /(ENABLED|FLAG)$/i.test(key))
    return { label: 'flag', tone: 'text-ok bg-ok-soft border-ok/20' }
  if (/(ENV|MODE|REGION|LOCALE|STAGE)$/i.test(key))
    return { label: 'config', tone: 'text-warn bg-warn-soft border-warn/20' }
  return { label: 'value', tone: 'text-muted-foreground bg-muted border-border' }
}

const SEV: Record<Severity, { icon: typeof Info; tone: string }> = {
  error: { icon: CircleAlert, tone: 'text-bad' },
  warning: { icon: AlertTriangle, tone: 'text-warn' },
  info: { icon: Info, tone: 'text-muted-foreground' }
}

function Reveal({
  path,
  line,
  shown,
  onShown,
  onHide
}: {
  path: string
  line: Extract<ViewLine, { kind: 'assign' }>
  shown: { key: string; value: string | null } | null
  onShown: (s: { key: string; value: string | null }) => void
  onHide: () => void
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const open = shown?.key === line.key
  if (line.length === 0)
    return <span className="font-mono text-[10px] text-muted-foreground">blank</span>
  if (open)
    return (
      <span className="inline-flex items-center gap-1">
        <code className="max-w-64 truncate rounded-sm bg-background px-1.5 py-0.5 font-mono text-[11px] select-text">
          {shown.value ?? '(not in file)'}
        </code>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Copy value"
          onClick={async () => {
            await navigator.clipboard.writeText(shown.value ?? '')
            setCopied(true)
            setTimeout(() => setCopied(false), 1200)
          }}
        >
          {copied ? <Check className="text-ok" /> : <Copy />}
        </Button>
        <Button size="icon-xs" variant="ghost" aria-label={`Hide ${line.key}`} onClick={onHide}>
          <EyeOff />
        </Button>
      </span>
    )
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className="font-mono text-[11px] tracking-[0.2em] text-muted-foreground"
        aria-hidden="true"
      >
        {line.mask}
      </span>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={`Reveal ${line.key}`}
        disabled={busy}
        onClick={async () => {
          setBusy(true)
          try {
            const r = await window.plumbr.revealValue({ path, key: line.key })
            onShown({ key: line.key, value: r.value })
          } catch (e) {
            toast.error(e instanceof Error ? e.message.replace(/^.*Error: /, '') : String(e))
          } finally {
            setBusy(false)
          }
        }}
      >
        {busy ? <Fingerprint className="animate-pulse" /> : <Eye />}
      </Button>
    </span>
  )
}

/**
 * One env file, two ways: UI (a card per key with its kind, shape and lint) and
 * File (the source with line numbers, colouring and a lint gutter). Values are
 * masks until a single key is revealed behind OS auth, for 20 seconds.
 */
export function EnvViewer({
  file,
  onClose
}: {
  file: EnvFileInfo
  onClose: () => void
}): React.JSX.Element {
  const [view, setView] = useState<EnvView | null>(null)
  const [mode, setMode] = useState<'ui' | 'file'>('ui')
  const [shown, setShown] = useState<{ key: string; value: string | null } | null>(null)
  const [formatting, setFormatting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const rescan = useWorkspace((s) => s.rescan)
  const noteWritten = useWorkspace((s) => s.noteWritten)

  useEffect(() => {
    let live = true
    window.plumbr
      .viewEnv({ path: file.path })
      .then((v) => live && setView(v))
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      live = false
    }
  }, [file.path, file.modifiedAt])

  useEffect(() => {
    if (!shown) return
    const t = setTimeout(() => setShown(null), HIDE_AFTER_MS)
    return () => clearTimeout(t)
  }, [shown])

  const byLine = new Map<number, LintIssue[]>()
  for (const i of view?.lint ?? []) byLine.set(i.line, [...(byLine.get(i.line) ?? []), i])
  const counts = { error: 0, warning: 0, info: 0 }
  for (const i of view?.lint ?? []) counts[i.severity]++
  const fixable = (view?.lint ?? []).filter((i) => i.fixable).length
  const assigns = (view?.lines ?? []).filter(
    (l): l is Extract<ViewLine, { kind: 'assign' }> => l.kind === 'assign'
  )

  const format = async (): Promise<void> => {
    if (
      !window.confirm(
        `Rewrite ${file.rel} in canonical form? Spelling only: KEY=value, quotes where needed, whitespace tidied. Meaning, order and comments stay. A snapshot is taken first.`
      )
    )
      return
    setFormatting(true)
    try {
      const r = await window.plumbr.formatEnv({ path: file.path, expectedMtime: file.modifiedAt })
      if (r.changed === 0) toast('Already formatted')
      else {
        noteWritten(0)
        toast.success(`Formatted ${file.rel}`, {
          description: `${r.changed} lines changed. Roll back from History.`
        })
        await rescan()
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message.replace(/^.*Error: /, '') : String(e))
    } finally {
      setFormatting(false)
    }
  }

  return (
    <div className="enter flex min-h-0 flex-1 flex-col" aria-label={`${file.rel} viewer`}>
      <header className="flex h-11 shrink-0 items-center gap-3 border-b px-4">
        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={file.path}>
          {file.rel}
        </span>
        <div role="tablist" aria-label="View mode" className="inline-flex rounded-md border p-0.5">
          {(['ui', 'file'] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              onClick={() => setMode(m)}
              className={cn(
                'h-6 rounded-sm px-2.5 text-[11px] uppercase transition-colors duration-(--duration-fast)',
                mode === m ? 'bg-accent font-medium' : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {m}
            </button>
          ))}
        </div>
        <span
          className="inline-flex items-center gap-2 font-mono text-[11px]"
          aria-label="Lint summary"
        >
          {counts.error > 0 && <span className="text-bad">{counts.error} errors</span>}
          {counts.warning > 0 && <span className="text-warn">{counts.warning} warnings</span>}
          {counts.info > 0 && <span className="text-muted-foreground">{counts.info} hints</span>}
          {view && view.lint.length === 0 && <span className="text-ok">clean</span>}
        </span>
        <Button
          size="xs"
          variant={view?.formatted ? 'ghost' : 'outline'}
          className="press"
          disabled={!view || view.formatted || formatting}
          title={
            view?.formatted
              ? 'Already in canonical form'
              : `Fix ${fixable} fixable hint${fixable === 1 ? '' : 's'} and tidy spelling`
          }
          onClick={format}
        >
          {formatting ? (
            <Loader2 className="animate-spin motion-reduce:animate-none" />
          ) : (
            <Sparkles />
          )}
          {view?.formatted ? 'Formatted' : 'Format'}
        </Button>
        <Button size="icon-xs" variant="ghost" aria-label="Close file" onClick={onClose}>
          <X />
        </Button>
      </header>
      {error && (
        <p role="alert" className="border-b bg-bad-soft px-4 py-1.5 text-xs text-bad">
          {error}
        </p>
      )}

      {!view ? (
        <div className="scanline mt-0" aria-hidden="true" />
      ) : mode === 'ui' ? (
        <ul className="stagger min-h-0 flex-1 overflow-auto p-3" aria-label="Keys">
          {assigns.map((l, i) => {
            const k = kindOf(l.key)
            const issues = byLine.get(l.n) ?? []
            return (
              <li
                key={l.n}
                style={{ '--i': i } as CSSProperties}
                className={cn(
                  'elev mb-2 rounded-lg border bg-card px-3 py-2',
                  l.shadowed && 'opacity-60',
                  shown?.key === l.key && 'border-lemon-ink/40 bg-lemon-soft/40'
                )}
              >
                <div className="flex items-center gap-2">
                  <span
                    className={cn('rounded-md border px-1.5 py-0.5 font-mono text-[10px]', k.tone)}
                  >
                    {k.label}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-xs font-medium">
                    {l.key}
                  </span>
                  <Reveal
                    path={file.path}
                    line={l}
                    shown={shown}
                    onShown={setShown}
                    onHide={() => setShown(null)}
                  />
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
                  <span>line {l.n}</span>
                  <span>· {l.length} chars</span>
                  {l.quote && (
                    <span>
                      · {l.quote === '"' ? 'double' : l.quote === "'" ? 'single' : 'backtick'}{' '}
                      quoted
                    </span>
                  )}
                  {l.multiline && <span>· multi-line</span>}
                  {l.export && <span>· export</span>}
                  {l.shadowed && (
                    <span className="text-warn">· shadowed by a later assignment</span>
                  )}
                  {l.comment && (
                    <span className="truncate text-muted-foreground/70">· {l.comment}</span>
                  )}
                </div>
                {issues.length > 0 && (
                  <ul className="mt-1.5 space-y-0.5">
                    {issues.map((is) => {
                      const S = SEV[is.severity]
                      return (
                        <li
                          key={is.rule}
                          className={cn('flex items-center gap-1.5 text-[11px]', S.tone)}
                        >
                          <S.icon className="size-3" aria-hidden="true" />
                          {is.message}
                          {is.fixable && (
                            <span className="text-muted-foreground">· fixable by Format</span>
                          )}
                        </li>
                      )
                    })}
                  </ul>
                )}
              </li>
            )
          })}
          {assigns.length === 0 && (
            <li className="p-6 text-center text-xs text-muted-foreground">No keys in this file.</li>
          )}
        </ul>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto font-mono text-xs">
          <table className="w-full border-collapse">
            <tbody className="stagger">
              {view.lines.map((l, i) => {
                const issues = byLine.get(l.n) ?? []
                const worst =
                  issues.find((x) => x.severity === 'error') ??
                  issues.find((x) => x.severity === 'warning') ??
                  issues[0]
                const W = worst ? SEV[worst.severity] : null
                return (
                  <tr
                    key={l.n}
                    style={{ '--i': Math.min(i, 30) } as CSSProperties}
                    className={cn(
                      'group hover:bg-accent/30',
                      l.kind === 'assign' && shown?.key === l.key && 'bg-lemon-soft/40'
                    )}
                  >
                    <td className="w-10 border-r py-0.5 pr-2 text-right text-[10px] text-muted-foreground select-none">
                      {l.n}
                    </td>
                    <td
                      className="w-5 py-0.5 text-center"
                      title={issues.map((x) => x.message).join('\n')}
                    >
                      {W && (
                        <W.icon
                          className={cn('inline size-3', W.tone)}
                          aria-label={worst!.message}
                        />
                      )}
                    </td>
                    <td className="py-0.5 pr-3 whitespace-pre">
                      {l.kind === 'blank' && ''}
                      {l.kind === 'comment' && (
                        <span className="text-muted-foreground/70">{l.text}</span>
                      )}
                      {l.kind === 'invalid' && <span className="text-bad">{l.text}</span>}
                      {l.kind === 'assign' && (
                        <span className="inline-flex items-center gap-0">
                          {l.export && <span className="text-muted-foreground">export </span>}
                          <span
                            className={cn(
                              'text-lemon-ink',
                              l.shadowed && 'line-through opacity-60'
                            )}
                          >
                            {l.key}
                          </span>
                          <span className="text-muted-foreground">=</span>
                          {l.quote && <span className="text-muted-foreground">{l.quote}</span>}
                          <Reveal
                            path={file.path}
                            line={l}
                            shown={shown}
                            onShown={setShown}
                            onHide={() => setShown(null)}
                          />
                          {l.quote && <span className="text-muted-foreground">{l.quote}</span>}
                          {l.multiline && (
                            <span className="ml-1 text-[10px] text-muted-foreground">
                              ⏎ multi-line
                            </span>
                          )}
                          {l.comment && (
                            <span className="ml-2 text-muted-foreground/70">{l.comment}</span>
                          )}
                        </span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="shrink-0 border-t px-4 py-1.5 text-[10px] text-muted-foreground">
        Values are masks until you reveal one key behind OS authentication, for 20 s. Format
        rewrites spelling only, through the same snapshot and atomic write as Apply.
      </p>
    </div>
  )
}
