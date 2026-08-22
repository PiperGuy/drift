import { useEffect, useState } from 'react'
import { siClaude, siCursor, siGithubcopilot, siGooglegemini, siWindsurf } from 'simple-icons'
import { Check, Loader2 } from 'lucide-react'
import type { McpClientId, McpClientStatus } from '@shared/channels'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

type Mark = { path: string; hex: string } | 'codex'
const MARK: Record<McpClientId, Mark> = {
  'claude-code': siClaude,
  'claude-desktop': siClaude,
  codex: 'codex',
  cursor: siCursor,
  copilot: siGithubcopilot,
  windsurf: siWindsurf,
  gemini: siGooglegemini
}

function Logo({ id }: { id: McpClientId }): React.JSX.Element {
  const m = MARK[id]
  if (m === 'codex')
    return (
      <span className="grid size-5 place-items-center rounded-sm bg-foreground font-mono text-[10px] font-bold text-background">
        {'>'}_
      </span>
    )
  // Cursor, Copilot and Windsurf are black marks: follow the text colour so they read in dark mode.
  const brand = ['000000', '0B100F', '191919'].includes(m.hex) ? 'currentColor' : `#${m.hex}`
  return (
    <svg viewBox="0 0 24 24" className="size-5" aria-hidden="true">
      <path d={m.path} fill={brand} />
    </svg>
  )
}

/**
 * One click per client: writes one `drift` entry into that client's MCP config
 * (and, for Claude Code, the Drift skill). Remove reverses it. Nothing else in
 * those files is touched.
 */
export function McpClients({ disabled = false }: { disabled?: boolean }): React.JSX.Element {
  const [clients, setClients] = useState<McpClientStatus[] | null>(null)
  const [busy, setBusy] = useState<McpClientId | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    window.plumbr.mcpClients().then(setClients)
  }, [])

  const act = async (c: McpClientStatus): Promise<void> => {
    setBusy(c.id)
    setError(null)
    try {
      setClients(
        await (c.installed ? window.plumbr.mcpUninstall(c.id) : window.plumbr.mcpInstall(c.id))
      )
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^.*Error: /, '') : String(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div>
      <ul className="stagger divide-y border-y" aria-label="MCP clients">
        {clients?.map((c, i) => (
          <li
            key={c.id}
            style={{ '--i': i } as React.CSSProperties}
            className={cn('flex items-center gap-3 py-2.5', disabled && 'opacity-50')}
          >
            <Logo id={c.id} />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{c.label}</p>
              <p className="truncate font-mono text-[10px] text-muted-foreground" title={c.file}>
                {c.file}
                {c.skill && ' · + skill'}
              </p>
            </div>
            {c.installed && (
              <span className="inline-flex items-center gap-1 text-[11px] text-ok">
                <Check className="size-3.5" aria-hidden="true" /> installed
              </span>
            )}
            <Button
              size="xs"
              variant={c.installed ? 'outline' : 'default'}
              className="press w-20"
              disabled={disabled || busy !== null}
              onClick={() => act(c)}
            >
              {busy === c.id ? (
                <Loader2 className="animate-spin motion-reduce:animate-none" />
              ) : c.installed ? (
                'Remove'
              ) : (
                'Install'
              )}
            </Button>
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className="mt-2 text-xs text-bad">
          {error}
        </p>
      )}
    </div>
  )
}
