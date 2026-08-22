import { useEffect, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import type { AppInfo } from '@shared/channels'
import { PRODUCT } from '@shared/product'
import { Button } from '@/components/ui/button'

const TOOLS = [
  ['list_projects', 'Every .env* file, grouped by Git project. Names, kinds, sizes, dates.'],
  ['env_status', 'Key names of one file, and which are blank.'],
  [
    'compare_env',
    'Drift receipt between two files: same, changed, missing, extra, blank, ignored.'
  ],
  ['dry_run_plan', 'What an approved sync would do per key: add, update, keep, review.']
] as const

const q = (s: string): string => (/[\s"]/.test(s) ? JSON.stringify(s) : s)

function Snippet({ label, code }: { label: string; code: string }): React.JSX.Element {
  const [done, setDone] = useState(false)
  return (
    <div className="elev overflow-hidden rounded-lg border bg-card">
      <div className="flex h-9 items-center justify-between border-b px-3">
        <span className="text-xs font-medium">{label}</span>
        <Button
          size="xs"
          variant="ghost"
          aria-label={`Copy ${label}`}
          onClick={async () => {
            await navigator.clipboard.writeText(code)
            setDone(true)
            setTimeout(() => setDone(false), 1500)
          }}
        >
          {done ? <Check className="text-ok" /> : <Copy />} {done ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <pre className="overflow-x-auto p-3 font-mono text-[11px] leading-relaxed whitespace-pre select-text">
        {code}
      </pre>
    </div>
  )
}

/** MCP for coding agents: read-only, redacted, local stdio. The server ships inside the app. */
export function AgentsPage(): React.JSX.Element {
  const [info, setInfo] = useState<AppInfo | null>(null)
  useEffect(() => {
    window.plumbr.appInfo().then(setInfo)
  }, [])
  const name = PRODUCT.toLowerCase()
  const m = info?.mcp
  const claude = m
    ? `claude mcp add ${name} ${Object.entries(m.env)
        .map(([k, v]) => `-e ${k}=${v}`)
        .join(' ')} -- ${q(m.command)} ${m.args.map(q).join(' ')}`
    : '…'
  const json = m
    ? JSON.stringify(
        { mcpServers: { [name]: { command: m.command, args: m.args, env: m.env } } },
        null,
        2
      )
    : '…'

  return (
    <div className="h-full overflow-auto">
      <header className="glow flex h-14 shrink-0 items-center gap-3 border-b px-5">
        <div className="min-w-0 flex-1">
          <h1 className="text-base font-semibold tracking-tight">Agents</h1>
          <p className="font-mono text-[11px] text-muted-foreground">
            MCP server · stdio · read-only · values never returned
          </p>
        </div>
      </header>
      <div className="mx-auto max-w-2xl space-y-6 p-6">
        <p className="text-sm leading-relaxed text-muted-foreground">
          Give Claude Code, Cursor or any MCP client the shape of your environments: key names,
          drift classes and dry-run plans for the workspace you granted here. The server runs
          locally from inside {PRODUCT}, reads nothing outside that folder, and has no tool that
          writes or syncs.
        </p>

        <section className="space-y-3">
          <h2 className="text-[11px] font-medium tracking-widest text-muted-foreground uppercase">
            Claude Code
          </h2>
          <Snippet label="Run once in a terminal" code={claude} />
        </section>

        <section className="space-y-3">
          <h2 className="text-[11px] font-medium tracking-widest text-muted-foreground uppercase">
            Cursor, Windsurf, Claude Desktop and others
          </h2>
          <Snippet label="Add to the client's MCP config" code={json} />
        </section>

        <section>
          <h2 className="text-[11px] font-medium tracking-widest text-muted-foreground uppercase">
            Tools
          </h2>
          <dl className="mt-2 divide-y border-y">
            {TOOLS.map(([t, d]) => (
              <div key={t} className="grid grid-cols-[9rem_1fr] gap-3 py-2.5 text-sm">
                <dt className="font-mono text-xs text-lemon-ink">{t}</dt>
                <dd className="text-xs text-muted-foreground">{d}</dd>
              </div>
            ))}
          </dl>
        </section>
      </div>
    </div>
  )
}
