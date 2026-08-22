import { useEffect, useState } from 'react'
import { useTheme } from 'next-themes'
import { transitionTheme } from '@/lib/theme'
import { PRODUCT } from '@shared/product'
import { Button } from '@/components/ui/button'
import type { AppInfo } from '@shared/channels'
import { useWorkspace, DEFAULT_IGNORE } from '@/store/workspace'
import { cn } from '@/lib/utils'

const THEMES = [
  { id: 'system', label: 'System' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' }
] as const

function Row({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="grid grid-cols-[8rem_1fr] items-start gap-4 py-3 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

export function SettingsPage(): React.JSX.Element {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const { theme, setTheme } = useTheme()
  const reset = useWorkspace((s) => s.reset)
  useEffect(() => {
    window.plumbr.appInfo().then(setInfo)
  }, [])
  return (
    <div className="h-full overflow-auto p-6">
      <div className="mx-auto max-w-2xl">
        <h1 className="text-lg font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Theme and workspace are remembered. Everything stored is redacted: paths, key names and
          counts, never a value.
        </p>

        <h2 className="mt-6 text-[11px] font-medium tracking-widest text-muted-foreground uppercase">
          Appearance
        </h2>
        <div className="divide-y border-y">
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
        </div>

        <h2 className="mt-6 text-[11px] font-medium tracking-widest text-muted-foreground uppercase">
          Comparison
        </h2>
        <div className="divide-y border-y">
          <Row label="Ignored keys">
            <code className="font-mono text-xs">{DEFAULT_IGNORE.join(', ')}</code>
            <p className="mt-1 text-xs text-muted-foreground">
              Expected to differ per environment, so never counted as drift. Editing this list is
              not available yet.
            </p>
          </Row>
          <Row label="Fingerprints">
            <p className="text-xs text-muted-foreground">
              {info?.keyPersisted
                ? 'HMAC-SHA256 with a per-install key sealed by the OS keyring. Receipts stay comparable across launches and are useless off this machine.'
                : 'HMAC-SHA256 with a random key generated at launch. No OS keyring is available, so fingerprints only agree with each other while the app runs.'}
            </p>
          </Row>
        </div>

        <h2 className="mt-6 text-[11px] font-medium tracking-widest text-muted-foreground uppercase">
          Data
        </h2>
        <div className="divide-y border-y">
          <Row label="Location">
            <code className="font-mono text-xs break-all">{info?.dataPath ?? '…'}</code>
            <p className="mt-1 text-xs text-muted-foreground">
              SQLite. Holds the granted root, redacted receipts and the history log.
            </p>
          </Row>
          <Row label="Forget">
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
            <p className="mt-1 text-xs text-muted-foreground">
              Removes everything above. The fingerprint key stays, so nothing becomes less private
              by keeping it.
            </p>
          </Row>
        </div>

        <h2 className="mt-6 text-[11px] font-medium tracking-widest text-muted-foreground uppercase">
          About
        </h2>
        <div className="divide-y border-y">
          <Row label="Version">
            <span className="font-mono text-xs">{info ? `${PRODUCT} ${info.version}` : '…'}</span>
          </Row>
          <Row label="Runtime">
            <span className="font-mono text-xs text-muted-foreground">
              {info &&
                `${info.platform} · Electron ${info.electron} · Node ${info.node} · Chromium ${info.chrome}`}
            </span>
          </Row>
        </div>
      </div>
    </div>
  )
}
