import { useEffect, useRef, useState, type CSSProperties } from 'react'
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
  Pencil,
  Plus,
  Save,
  Search,
  Sparkles,
  X
} from 'lucide-react'
import { toast } from 'sonner'
import type { EnvFileInfo } from '@shared/channels'
import type { EnvView, LintIssue, Severity, ViewLine } from '@shared/env-lint'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
  onHide,
  all
}: {
  path: string
  line: Extract<ViewLine, { kind: 'assign' }>
  shown: { key: string; value: string | null } | null
  onShown: (s: { key: string; value: string | null }) => void
  onHide: () => void
  /** Set while "Reveal all" is active: every key shows from this map. */
  all?: Record<string, string> | null
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  if (all && line.length > 0 && !line.shadowed)
    return (
      <code className="max-w-64 truncate rounded-sm bg-background px-1.5 py-0.5 font-mono text-[11px] select-text">
        {all[line.key] ?? '(not in file)'}
      </code>
    )
  const open = shown?.key === line.key
  if (line.length === 0)
    return <span className="font-mono text-[10px] text-muted-foreground">blank</span>
  // Reveal fetches the effective (last) value; a shadowed line would show the wrong one.
  if (line.shadowed)
    return (
      <span
        className="font-mono text-[11px] tracking-[0.2em] text-muted-foreground"
        title="Shadowed: reveal the later assignment instead"
      >
        {line.mask}
      </span>
    )
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
  onClose,
  onDirtyChange
}: {
  file: EnvFileInfo
  onClose: () => void
  /** Lets the page guard project switches while there are unsaved edits. */
  onDirtyChange?: (dirty: boolean) => void
}): React.JSX.Element {
  const [view, setView] = useState<EnvView | null>(null)
  // Pending edits: key → typed value. Existing keys update in place, new keys append.
  const [edits, setEdits] = useState<Map<string, string>>(new Map())
  const [editing, setEditing] = useState<string | null>(null)
  const [adding, setAdding] = useState<{ key: string; value: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const dirty = edits.size > 0
  // Baseline for the stale-file guard: the mtime when the first edit was staged, not after a rescan.
  const [baseMtime, setBaseMtime] = useState<number | null>(null)
  const stage = (key: string, value: string): void => {
    setBaseMtime((b) => b ?? file.modifiedAt)
    setEdits((m) => new Map(m).set(key, value))
  }
  const clearEdits = (): void => {
    setEdits(new Map())
    setEditing(null)
    setBaseMtime(null)
  }
  useEffect(() => {
    onDirtyChange?.(dirty)
    return () => onDirtyChange?.(false)
  }, [dirty, onDirtyChange])
  const guardedClose = (): void => {
    if (
      dirty &&
      !window.confirm(
        `Discard ${edits.size} unsaved change${edits.size === 1 ? '' : 's'} to ${file.rel}?`
      )
    )
      return
    onClose()
  }
  const [mode, setMode] = useState<'ui' | 'file'>('ui')
  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  // Cmd/Ctrl+F inside the viewer targets this box; the page-level handler is shadowed while open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        e.stopImmediatePropagation()
        searchRef.current?.focus()
        searchRef.current?.select()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
  const q = query.trim().toLowerCase()
  const lineMatches = (l: ViewLine): boolean =>
    !q ||
    (l.kind === 'assign' && l.key.toLowerCase().includes(q)) ||
    (l.kind === 'comment' && l.text.toLowerCase().includes(q))
  const [shown, setShown] = useState<{ key: string; value: string | null } | null>(null)
  const [all, setAll] = useState<Record<string, string> | null>(null)
  const [revealingAll, setRevealingAll] = useState(false)
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
  useEffect(() => {
    if (!all) return
    const t = setTimeout(() => setAll(null), HIDE_AFTER_MS)
    return () => clearTimeout(t)
  }, [all])
  const revealAll = async (): Promise<void> => {
    if (all) {
      setAll(null)
      return
    }
    setRevealingAll(true)
    try {
      const r = await window.plumbr.revealAll({ path: file.path })
      setAll(r.values)
      setShown(null)
    } catch (e) {
      toast.error(e instanceof Error ? e.message.replace(/^.*Error: /, '') : String(e))
    } finally {
      setRevealingAll(false)
    }
  }

  const byLine = new Map<number, LintIssue[]>()
  for (const i of view?.lint ?? []) byLine.set(i.line, [...(byLine.get(i.line) ?? []), i])
  const counts = { error: 0, warning: 0, info: 0 }
  for (const i of view?.lint ?? []) counts[i.severity]++
  const fixable = (view?.lint ?? []).filter((i) => i.fixable).length
  const assigns = (view?.lines ?? []).filter(
    (l): l is Extract<ViewLine, { kind: 'assign' }> => l.kind === 'assign' && lineMatches(l)
  )
  const fileLines = (view?.lines ?? []).filter(lineMatches)

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

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      const r = await window.plumbr.setValues({
        path: file.path,
        expectedMtime: baseMtime ?? file.modifiedAt,
        entries: [...edits].map(([key, value]) => ({ key, value }))
      })
      noteWritten(r.written.length)
      clearEdits()
      toast.success(
        `Saved ${r.written.length} key${r.written.length === 1 ? '' : 's'} to ${file.rel}`,
        {
          description: 'Snapshot taken first. Roll back from History.'
        }
      )
      await rescan()
    } catch (e) {
      toast.error(e instanceof Error ? e.message.replace(/^.*Error: /, '') : String(e))
    } finally {
      setSaving(false)
    }
  }
  // Every key in the file, regardless of the search filter.
  const existing = new Set((view?.lines ?? []).flatMap((l) => (l.kind === 'assign' ? [l.key] : [])))
  const newKeys = [...edits.keys()].filter(
    (k) => !(view?.lines ?? []).some((l) => l.kind === 'assign' && l.key === k)
  )

  return (
    <div className="enter flex min-h-0 flex-1 flex-col" aria-label={`${file.rel} viewer`}>
      <header className="flex min-h-11 shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b px-4 py-1.5">
        <span className="min-w-32 flex-1 truncate font-mono text-xs" title={file.path}>
          {file.rel}
        </span>
        <div className="relative w-40 shrink">
          <Search
            className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            ref={searchRef}
            aria-label="Search keys in file"
            placeholder="Search keys"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
            className="h-7 pl-7 font-mono text-xs"
          />
          {query && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setQuery('')}
              className="absolute top-1/2 right-1.5 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
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
          variant={all ? 'default' : 'outline'}
          className="press"
          disabled={!view || revealingAll}
          title={
            all
              ? 'Hide every value'
              : 'Show every value for 20 seconds (asks the OS once per session)'
          }
          onClick={revealAll}
        >
          {revealingAll ? <Fingerprint className="animate-pulse" /> : all ? <EyeOff /> : <Eye />}
          {all ? 'Hide all' : 'Reveal all'}
        </Button>
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
        <Button size="icon-xs" variant="ghost" aria-label="Close file" onClick={guardedClose}>
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
        <>
          <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5">
            {adding ? (
              <form
                className="flex flex-1 items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault()
                  const key = adding.key.trim()
                  if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key)) {
                    toast.error('Key must be letters, digits and _ . -, not starting with a digit')
                    return
                  }
                  if (existing.has(key) || edits.has(key)) {
                    toast.error(`${key} already exists; edit it instead`)
                    return
                  }
                  stage(key, adding.value)
                  setAdding(null)
                }}
              >
                <Input
                  autoFocus
                  aria-label="New key"
                  placeholder="NEW_KEY"
                  value={adding.key}
                  onChange={(e) => setAdding({ ...adding, key: e.target.value.toUpperCase() })}
                  className="h-7 w-48 font-mono text-xs"
                  spellCheck={false}
                />
                <span className="text-muted-foreground">=</span>
                <Input
                  aria-label="New value"
                  placeholder="value"
                  type="password"
                  value={adding.value}
                  onChange={(e) => setAdding({ ...adding, value: e.target.value })}
                  className="h-7 flex-1 font-mono text-xs"
                  spellCheck={false}
                  autoComplete="off"
                />
                <Button type="submit" size="xs" className="press">
                  Add
                </Button>
                <Button type="button" size="xs" variant="ghost" onClick={() => setAdding(null)}>
                  Cancel
                </Button>
              </form>
            ) : (
              <Button
                size="xs"
                variant="outline"
                className="press"
                onClick={() => setAdding({ key: '', value: '' })}
              >
                <Plus /> Add key
              </Button>
            )}
            {dirty && !adding && (
              <span className="ml-auto inline-flex items-center gap-2">
                <span className="font-mono text-[11px] text-warn">
                  {edits.size} unsaved change{edits.size === 1 ? '' : 's'}
                </span>
                <Button size="xs" variant="ghost" onClick={clearEdits} disabled={saving}>
                  Discard
                </Button>
                <Button size="xs" className="press" onClick={save} disabled={saving}>
                  {saving ? (
                    <Loader2 className="animate-spin motion-reduce:animate-none" />
                  ) : (
                    <Save />
                  )}{' '}
                  Save
                </Button>
              </span>
            )}
          </div>
          <ul className="stagger min-h-0 flex-1 overflow-auto p-3" aria-label="Keys">
            {newKeys.map((k) => (
              <li
                key={`new:${k}`}
                className="elev mb-2 rounded-lg border border-lemon-ink/40 bg-lemon-soft/40 px-3 py-2"
              >
                <div className="flex items-center gap-2">
                  <span className="rounded-md border border-lemon-ink/20 bg-lemon-soft px-1.5 py-0.5 font-mono text-[10px] text-lemon-ink">
                    new
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-xs font-medium">{k}</span>
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {'•'.repeat(Math.min(edits.get(k)!.length, 24)) || 'blank'}
                  </span>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Remove ${k}`}
                    onClick={() =>
                      setEdits((m) => {
                        const n = new Map(m)
                        n.delete(k)
                        return n
                      })
                    }
                  >
                    <X />
                  </Button>
                </div>
              </li>
            ))}
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
                      className={cn(
                        'rounded-md border px-1.5 py-0.5 font-mono text-[10px]',
                        k.tone
                      )}
                    >
                      {k.label}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-xs font-medium">
                      {l.key}
                    </span>
                    {editing === l.key ? (
                      <form
                        className="flex flex-1 items-center gap-1.5"
                        onSubmit={(e) => {
                          e.preventDefault()
                          const v = (new FormData(e.currentTarget).get('v') as string) ?? ''
                          stage(l.key, v)
                          setEditing(null)
                        }}
                      >
                        <Input
                          autoFocus
                          name="v"
                          aria-label={`New value for ${l.key}`}
                          type={shown?.key === l.key ? 'text' : 'password'}
                          defaultValue={
                            edits.get(l.key) ?? (shown?.key === l.key ? (shown.value ?? '') : '')
                          }
                          placeholder={
                            shown?.key === l.key ? '' : 'new value (current stays hidden)'
                          }
                          className="h-7 flex-1 font-mono text-xs"
                          spellCheck={false}
                          autoComplete="off"
                          onKeyDown={(e) => e.key === 'Escape' && setEditing(null)}
                        />
                        <Button type="submit" size="xs" className="press">
                          Set
                        </Button>
                        <Button
                          type="button"
                          size="xs"
                          variant="ghost"
                          onClick={() => setEditing(null)}
                        >
                          Cancel
                        </Button>
                      </form>
                    ) : (
                      <>
                        {edits.has(l.key) && (
                          <span className="font-mono text-[10px] text-warn" title="Unsaved">
                            pending
                          </span>
                        )}
                        <Reveal
                          path={file.path}
                          line={l}
                          shown={shown}
                          onShown={setShown}
                          onHide={() => setShown(null)}
                          all={all}
                        />
                        {!l.shadowed && (
                          <Button
                            size="icon-xs"
                            variant="ghost"
                            aria-label={`Edit ${l.key}`}
                            onClick={() => setEditing(l.key)}
                          >
                            <Pencil />
                          </Button>
                        )}
                      </>
                    )}
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
            {assigns.length === 0 && newKeys.length === 0 && (
              <li className="p-6 text-center text-xs text-muted-foreground">
                {q ? 'No keys match.' : 'No keys in this file.'}
              </li>
            )}
          </ul>
        </>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto font-mono text-xs">
          <table className="w-full border-collapse">
            <tbody className="stagger">
              {fileLines.map((l, i) => {
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
                            all={all}
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
        Values are hidden. The first time you reveal one, the OS asks you to confirm; after that it
        doesn&apos;t for the rest of the session. A value stays visible for 20 seconds. Format
        tidies the file without changing what it means, and takes a snapshot first.
      </p>
    </div>
  )
}
