import { useEffect, useState } from 'react'
import { useTheme } from 'next-themes'
import { Download, Loader2, RefreshCw } from 'lucide-react'
import { transitionTheme } from '@/lib/theme'
import { PRODUCT } from '@shared/product'
import type { AppInfo, Settings as SettingsT, UpdateResult } from '@shared/channels'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { LicenseForm } from '@/components/app/LicenseForm'
import { McpClients } from '@/components/app/McpClients'
import { useWorkspace, DEFAULT_IGNORE } from '@/store/workspace'
import { cn } from '@/lib/utils'

const THEMES = [
  { id: 'system', label: 'System' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' }
] as const

/** Provider adapters from the site. None exist yet; listed so the shape of the page is honest. */
const PROVIDERS = [
  'GitHub Actions',
  'Vercel',
  'Railway',
  'Render',
  'Dokploy',
  'Coolify',
  'AWS Secrets Manager',
  'HashiCorp Vault KV v2'
]

function Section({
  title,
  children
}: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="mt-7">
      <h2 className="text-[11px] font-medium tracking-widest text-muted-foreground uppercase">
        {title}
      </h2>
      <div className="mt-2 divide-y border-y">{children}</div>
    </section>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="grid grid-cols-[8rem_1fr] items-start gap-4 py-3 text-sm">
      <span className="pt-0.5 text-muted-foreground">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

const Hint = ({ children }: { children: React.ReactNode }): React.JSX.Element => (
  <p className="mt-1 text-xs text-muted-foreground">{children}</p>
)

export function SettingsPage(): React.JSX.Element {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [settings, setSettings] = useState<SettingsT | null>(null)
  const [update, setUpdate] = useState<UpdateResult | 'checking' | null>(null)
  const { theme, setTheme } = useTheme()
  const license = useWorkspace((s) => s.license)
  const reset = useWorkspace((s) => s.reset)
  const setPage = useWorkspace((s) => s.setPage)
  const setOnboarded = useWorkspace((s) => s.setOnboarded)
  useEffect(() => {
    window.plumbr.appInfo().then(setInfo)
    window.plumbr.getSettings().then(setSettings)
  }, [])

  return (
    <div className="h-full overflow-auto">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b px-5">
        <div className="min-w-0 flex-1">
          <h1 className="text-base font-semibold tracking-tight">Settings</h1>
          <p className="font-mono text-[11px] text-muted-foreground">
            Everything stored is redacted: paths, key names, counts. Never a value.
          </p>
        </div>
      </header>
      <div className="mx-auto max-w-2xl px-6 pb-10">
        <Section title="Appearance">
          <Row label="Theme">
            <div
              role="radiogroup"
              aria-label="Theme"
              className="inline-flex rounded-md border p-0.5"
            >
              {THEMES.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="radio"
                  aria-checked={theme === t.id}
                  onClick={() => transitionTheme(setTheme, t.id)}
                  className={cn(
                    'h-7 rounded-sm px-3 text-xs transition-colors duration-(--duration-fast)',
                    theme === t.id
                      ? 'bg-accent font-medium text-foreground'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </Row>
        </Section>

        <Section title="Getting started">
          <Row label="Tour">
            <Button variant="outline" size="sm" onClick={() => setOnboarded(false)}>
              Replay the onboarding
            </Button>
            <Hint>Access, first receipt, agents and shortcuts. Your data is untouched.</Hint>
          </Row>
        </Section>

        <Section title="License">
          <Row label="Status">
            {license?.state === 'licensed' ? (
              <p className="text-sm">
                <span className="text-ok">Licensed</span> to{' '}
                <span className="font-medium">{license.name}</span>
                {license.expiresAt && (
                  <span className="text-muted-foreground">
                    {' '}
                    · until {new Date(license.expiresAt).toLocaleDateString()}
                  </span>
                )}
              </p>
            ) : license?.state === 'trial' ? (
              <p className="text-sm">
                <span className="text-warn">Trial</span> · {license.daysLeft} day
                {license.daysLeft === 1 ? '' : 's'} left, ends{' '}
                {new Date(license.endsAt).toLocaleDateString()}
              </p>
            ) : (
              <p className="text-sm text-bad">Locked</p>
            )}
          </Row>
          <Row label="Key">
            <LicenseForm />
            <Hint>
              Keys look like <code className="font-mono">DRIFT-…</code> and are verified on this
              machine. Nothing is sent anywhere.
            </Hint>
          </Row>
        </Section>

        <Section title="Agents (MCP)">
          <Row label="MCP server">
            <div className="flex items-center gap-3">
              <Switch
                id="mcp-enabled"
                checked={settings?.mcpEnabled ?? true}
                disabled={!settings}
                onCheckedChange={async (v) =>
                  setSettings(await window.plumbr.setSettings({ mcpEnabled: v }))
                }
              />
              <label htmlFor="mcp-enabled" className="text-sm">
                {settings?.mcpEnabled === false ? 'Off' : 'On'}
              </label>
            </div>
            <Hint>
              Off refuses every tool call immediately, even from clients already set up. Values are
              never served either way.
            </Hint>
          </Row>
          <Row label="Clients">
            <McpClients disabled={settings?.mcpEnabled === false} />
            <Hint>
              One click adds a <code className="font-mono">drift</code> entry to that client&apos;s
              own MCP config; Claude Code also gets the Drift skill. Manual config is on the{' '}
              <button
                type="button"
                className="text-lemon-ink underline-offset-2 hover:underline"
                onClick={() => setPage('agents')}
              >
                Agents
              </button>{' '}
              page.
            </Hint>
          </Row>
        </Section>

        <Section title="Updates">
          <Row label="Version">
            <div className="flex flex-wrap items-center gap-3">
              <span className="font-mono text-xs">{info ? `${PRODUCT} ${info.version}` : '…'}</span>
              <Button
                variant="outline"
                size="sm"
                className="press"
                disabled={update === 'checking'}
                onClick={async () => {
                  setUpdate('checking')
                  setUpdate(await window.plumbr.checkUpdates())
                }}
              >
                {update === 'checking' ? (
                  <Loader2 className="animate-spin motion-reduce:animate-none" />
                ) : (
                  <RefreshCw />
                )}
                Check for updates
              </Button>
            </div>
            {update && update !== 'checking' && (
              <p
                role="status"
                className={cn(
                  'mt-1.5 text-xs',
                  update.status === 'available'
                    ? 'text-lemon-ink'
                    : update.status === 'error'
                      ? 'text-muted-foreground'
                      : 'text-ok'
                )}
              >
                {update.status === 'available' ? (
                  <span className="inline-flex items-center gap-1">
                    <Download className="size-3.5" aria-hidden="true" /> {update.version} is
                    available. Download it from the Releases page; in-app install comes with signed
                    builds.
                  </span>
                ) : update.status === 'current' ? (
                  'You are on the latest version.'
                ) : (
                  update.message
                )}
              </p>
            )}
          </Row>
        </Section>

        <Section title="Integrations">
          <Row label="Connections">
            <ul className="grid grid-cols-2 gap-1.5">
              {PROVIDERS.map((p) => (
                <li
                  key={p}
                  className="flex items-center justify-between rounded-md border border-dashed px-2.5 py-1.5 text-xs"
                >
                  <span>{p}</span>
                  <span className="font-mono text-[10px] text-muted-foreground">coming soon</span>
                </li>
              ))}
            </ul>
            <Hint>
              Tokens will be sealed with the OS keyring and never written in the clear. No provider
              adapter is built yet, so there is nothing to connect.
            </Hint>
          </Row>
        </Section>

        <Section title="Comparison">
          <Row label="Ignored keys">
            <code className="font-mono text-xs">{DEFAULT_IGNORE.join(', ')}</code>
            <Hint>Expected to differ per environment, so never counted as drift.</Hint>
          </Row>
          <Row label="Fingerprints">
            <Hint>
              {info?.keyPersisted
                ? 'HMAC-SHA256 with a per-install key sealed by the OS keyring. Receipts stay comparable across launches and are useless off this machine.'
                : 'HMAC-SHA256 with a random key generated at launch. No OS keyring is available, so fingerprints only agree with each other while the app runs.'}
            </Hint>
          </Row>
        </Section>

        <Section title="Data">
          <Row label="Location">
            <code className="font-mono text-xs break-all">{info?.dataPath ?? '…'}</code>
            <Hint>SQLite. Granted root, redacted receipts, history, settings and license.</Hint>
          </Row>
          <Row label="Reset">
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  if (
                    !window.confirm('Clear every receipt and the history log? The workspace stays.')
                  )
                    return
                  await window.plumbr.clearCache()
                }}
              >
                Clear cache
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  if (!window.confirm('Forget the workspace, every receipt and the history log?'))
                    return
                  await window.plumbr.forgetData()
                  reset()
                }}
              >
                Forget workspace and history
              </Button>
            </div>
            <Hint>Neither touches the license or the fingerprint key.</Hint>
          </Row>
        </Section>

        <Section title="About">
          <Row label="Runtime">
            <span className="font-mono text-xs text-muted-foreground">
              {info &&
                `${info.platform} · Electron ${info.electron} · Node ${info.node} · Chromium ${info.chrome}`}
            </span>
          </Row>
        </Section>
      </div>
    </div>
  )
}
