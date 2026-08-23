import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Check,
  FolderOpen,
  FolderSearch,
  History,
  Keyboard,
  Lock,
  Receipt,
  ShieldCheck,
  WifiOff
} from 'lucide-react'
import type { AppInfo, EnvFileInfo } from '@shared/channels'
import { envKind } from '@shared/env-file'
import { PRODUCT } from '@shared/product'
import { Logo } from '@/components/app/Logo'
import { Lattice } from '@/components/app/Lattice'
import { McpClients } from '@/components/app/McpClients'
import { Button } from '@/components/ui/button'
import { UNGROUPED, useWorkspace } from '@/store/workspace'
import { cn } from '@/lib/utils'

const STEPS = ['Welcome', 'Access', 'First receipt', 'Agents', 'How it works'] as const
const isMac = navigator.platform.startsWith('Mac')
const MOD = isMac ? '⌘' : 'Ctrl+'
const i = (n: number): CSSProperties => ({ '--i': n }) as CSSProperties

function Eyebrow({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <p className="font-mono text-[11px] tracking-[0.2em] text-lemon-ink uppercase" style={i(1)}>
      {children}
    </p>
  )
}
function Title({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <h1 className="hero-title mt-2" style={i(2)}>
      {children}
    </h1>
  )
}
function Lead({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <p className="mt-3 max-w-lg text-[15px] leading-relaxed text-muted-foreground" style={i(3)}>
      {children}
    </p>
  )
}
function Card({
  n,
  icon: Icon,
  title,
  children
}: {
  n: number
  icon: React.ComponentType<{ className?: string }>
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="elev rounded-lg border bg-card/80 p-4 backdrop-blur-sm" style={i(n)}>
      <p className="flex items-center gap-2 text-[13px] font-medium">
        <Icon className="size-4 text-lemon-ink" /> {title}
      </p>
      <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{children}</p>
    </div>
  )
}

/** Pick the most useful first comparison: base vs production, else base vs anything, in the first project. */
function suggestPair(files: EnvFileInfo[]): [EnvFileInfo, EnvFileInfo] | null {
  const byProject = new Map<string, EnvFileInfo[]>()
  for (const f of files) {
    const k = f.project ?? UNGROUPED
    byProject.set(k, [...(byProject.get(k) ?? []), f])
  }
  for (const fs of byProject.values()) {
    if (fs.length < 2) continue
    const base = fs.find((f) => envKind(f.name) === 'base') ?? fs[0]
    const target =
      fs.find((f) => envKind(f.name) === 'production' && f !== base) ??
      fs.find((f) => envKind(f.name) === 'staging' && f !== base) ??
      fs.find((f) => f !== base)
    if (target) return [base, target]
  }
  return null
}

export function OnboardingPage(): React.JSX.Element {
  const [step, setStep] = useState(0)
  const [info, setInfo] = useState<AppInfo | null>(null)
  const {
    root,
    scan,
    scanning,
    error,
    grant,
    left,
    right,
    pick,
    compare,
    receipt,
    comparing,
    setOnboarded,
    setPage
  } = useWorkspace()
  useEffect(() => {
    window.plumbr.appInfo().then(setInfo)
  }, [])

  const pair = useMemo(() => (scan ? suggestPair(scan.files) : null), [scan])
  // Arriving at step 2 without a complete pair: apply the suggestion (replacing a half-picked one).
  useEffect(() => {
    if (step !== 2 || !pair || (left && right)) return
    pick('left', pair[0])
    pick('right', pair[1])
  }, [step, pair, left, right, pick])
  // Compare once per pair. A failure shows the error instead of retrying forever.
  const tried = useRef<string | null>(null)
  useEffect(() => {
    if (step !== 2 || !left || !right || receipt || comparing) return
    const id = `${left.path}→${right.path}`
    if (tried.current === id) return
    tried.current = id
    void compare()
  }, [step, left, right, receipt, comparing, compare])

  const finish = async (to: 'workspace' | 'receipt' = 'workspace'): Promise<void> => {
    await setOnboarded(true)
    setPage(to)
  }
  const next = (): void => setStep((s) => Math.min(s + 1, STEPS.length - 1))
  const back = (): void => setStep((s) => Math.max(s - 1, 0))
  const review = receipt
    ? receipt.counts.changed + receipt.counts.missing + receipt.counts.extra + receipt.counts.blank
    : 0
  const mac = (info?.platform ?? (isMac ? 'darwin' : 'linux')) === 'darwin'

  return (
    <div className="relative flex h-full flex-col">
      <Lattice className="absolute inset-0 size-full [mask-image:radial-gradient(ellipse_at_center,transparent_25%,black_85%)]" />

      {/* Progress */}
      <ol className="relative z-10 flex h-14 shrink-0 items-center gap-5 px-8" aria-label="Steps">
        {STEPS.map((s, n) => (
          <li key={s} className="flex items-center gap-2 text-xs">
            <span
              aria-current={n === step ? 'step' : undefined}
              className={cn(
                'grid size-5 place-items-center rounded-full border font-mono text-[10px] transition-colors duration-(--duration-base)',
                n < step
                  ? 'border-lemon-ink bg-lemon-ink text-primary-foreground'
                  : n === step
                    ? 'border-lemon-ink text-lemon-ink'
                    : 'text-muted-foreground'
              )}
            >
              {n < step ? <Check className="size-3" /> : n + 1}
            </span>
            <span className={cn(n === step ? 'font-medium' : 'text-muted-foreground')}>{s}</span>
          </li>
        ))}
        <button
          type="button"
          onClick={() => finish()}
          className="ml-auto text-xs text-muted-foreground hover:text-foreground"
        >
          Skip
        </button>
      </ol>

      <div className="relative z-10 flex min-h-0 flex-1 items-center justify-center overflow-auto p-8">
        <div key={step} className="stagger w-full max-w-2xl">
          {step === 0 && (
            <>
              <Logo size={48} draw />
              <div className="mt-6" />
              <Eyebrow>Welcome to {PRODUCT}</Eyebrow>
              <Title>
                Every <span className="text-lemon-ink">.env</span>, side by side. Never a value in
                sight.
              </Title>
              <Lead>
                {PRODUCT} finds the env files in a folder you choose, shows how local, staging and
                production differ by key name, and writes nothing unless you approve an exact plan.
                Two minutes and you have your first receipt.
              </Lead>
              <div className="mt-8 grid gap-3 sm:grid-cols-3">
                <Card n={5} icon={ShieldCheck} title="Reads only what you grant">
                  One folder. Nothing outside it is ever opened.
                </Card>
                <Card n={6} icon={Lock} title="Values stay in the engine">
                  The window, history and agents only ever see key names and classes.
                </Card>
                <Card n={7} icon={WifiOff} title="Nothing leaves this machine">
                  No account, no server, no telemetry. The status bar keeps count.
                </Card>
              </div>
            </>
          )}

          {step === 1 && (
            <>
              <Eyebrow>Step 1 · Access</Eyebrow>
              <Title>
                Point it at a <span className="text-lemon-ink">folder</span>.
              </Title>
              <Lead>
                Pick the folder that holds your projects, or one project. {PRODUCT} walks it, skips{' '}
                <code className="font-mono">node_modules</code>,{' '}
                <code className="font-mono">.git</code> and build output, and groups every{' '}
                <code className="font-mono">.env*</code> by Git repository. Files stay exactly where
                they are.
              </Lead>
              {mac && (
                <div
                  className="elev mt-6 flex gap-3 rounded-lg border border-lemon-ink/30 bg-lemon-soft/60 p-4 text-sm"
                  style={i(4)}
                >
                  <svg viewBox="0 0 24 24" className="mt-0.5 size-5 shrink-0" aria-hidden="true">
                    <path
                      fill="currentColor"
                      d="M16.4 12.7c0-2.5 2-3.7 2.1-3.8-1.2-1.7-3-1.9-3.6-2-1.5-.2-3 .9-3.7.9-.8 0-2-.9-3.2-.9-1.7 0-3.2 1-4.1 2.5-1.8 3-.5 7.6 1.3 10.1.9 1.2 1.9 2.6 3.2 2.5 1.3-.1 1.8-.8 3.3-.8s2 .8 3.3.8c1.4 0 2.2-1.2 3.1-2.5 1-1.4 1.4-2.8 1.4-2.9-.1 0-2.7-1-2.7-4ZM14 5.3c.7-.8 1.2-2 1-3.1-1 0-2.2.7-2.9 1.5-.6.7-1.2 1.9-1 3 1.1.1 2.2-.6 2.9-1.4Z"
                    />
                  </svg>
                  <div>
                    <p className="font-medium">macOS will ask once</p>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                      If the folder is in Desktop, Documents or Downloads, macOS shows its own
                      permission prompt the first time. Click <strong>Allow</strong>. {PRODUCT}{' '}
                      never needs Full Disk Access; you can review or revoke this any time under
                      System Settings → Privacy &amp; Security → Files and Folders.
                    </p>
                  </div>
                </div>
              )}
              <div className="mt-6 flex flex-wrap items-center gap-4" style={i(5)}>
                <Button size="lg" className="press cta-pulse" onClick={grant} disabled={scanning}>
                  <FolderOpen /> {root ? 'Choose a different folder' : 'Choose a folder'}
                </Button>
                {root && (
                  <span className="inline-flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
                    <Check className="size-3.5 text-ok" aria-hidden="true" />
                    <span className="max-w-sm truncate" title={root}>
                      {root}
                    </span>
                  </span>
                )}
              </div>
              {scanning && <div className="scanline mt-4" aria-hidden="true" />}
              {error && !scanning && (
                <p
                  role="alert"
                  className="mt-4 rounded-md border border-bad/30 bg-bad-soft px-3 py-2 text-xs text-bad"
                >
                  {error}. Try a different folder, or one you have permission to read.
                </p>
              )}
              {scan && !scanning && (
                <div className="mt-6 grid grid-cols-3 gap-3" style={i(6)}>
                  {[
                    [scan.files.length, 'env files'],
                    [scan.projects.length, 'projects'],
                    [scan.scannedDirs, 'folders walked']
                  ].map(([n, l]) => (
                    <div key={l} className="elev rounded-lg border bg-card/80 px-4 py-3">
                      <span
                        className="tally numeral text-2xl"
                        style={{ '--n': n } as CSSProperties}
                      >
                        <span className="sr-only">{n}</span>
                      </span>
                      <p className="mt-1 text-[11px] text-muted-foreground">{l}</p>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {step === 2 && (
            <>
              <Eyebrow>Step 2 · First receipt</Eyebrow>
              {pair && left && right ? (
                <>
                  <Title>
                    Your first <span className="text-lemon-ink">drift receipt</span>.
                  </Title>
                  <Lead>
                    Comparing <code className="font-mono text-foreground">{left.rel}</code> to{' '}
                    <code className="font-mono text-foreground">{right.rel}</code>. A receipt lists
                    every key with a class. Values are compared as local fingerprints and never
                    shown.
                  </Lead>
                  {comparing && <div className="scanline mt-4" aria-hidden="true" />}
                  {error && !comparing && (
                    <p
                      role="alert"
                      className="mt-4 rounded-md border border-bad/30 bg-bad-soft px-3 py-2 text-xs text-bad"
                    >
                      {error}
                    </p>
                  )}
                  {receipt && (
                    <div className="mt-6 flex flex-wrap gap-2" style={i(4)}>
                      <div
                        className={cn(
                          'stamp elev flex min-w-36 flex-col justify-center rounded-lg border px-4 py-2',
                          receipt.clean ? 'border-ok/30 bg-ok-soft' : 'border-warn/30 bg-warn-soft'
                        )}
                      >
                        <span
                          className={cn(
                            'numeral text-3xl',
                            receipt.clean ? 'text-ok' : 'tally text-warn'
                          )}
                          style={receipt.clean ? undefined : ({ '--n': review } as CSSProperties)}
                        >
                          {receipt.clean ? '✓' : <span className="sr-only">{review}</span>}
                        </span>
                        <span className="mt-1 text-[11px] text-muted-foreground">
                          {receipt.clean ? 'clean' : 'keys to review'}
                        </span>
                      </div>
                      {(['missing', 'changed', 'extra', 'blank', 'same'] as const).map((s) => (
                        <div
                          key={s}
                          className="elev flex min-w-20 flex-col justify-center rounded-lg border bg-card/80 px-3 py-2"
                        >
                          <span
                            className="tally numeral text-2xl"
                            style={{ '--n': receipt.counts[s] } as CSSProperties}
                          >
                            <span className="sr-only">{receipt.counts[s]}</span>
                          </span>
                          <span className="mt-1 text-[11px] text-muted-foreground">{s}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  <p className="mt-4 text-xs text-muted-foreground" style={i(5)}>
                    <strong className="text-foreground">missing</strong> and{' '}
                    <strong className="text-foreground">blank</strong> break deploys.{' '}
                    <strong className="text-foreground">changed</strong> is normal between
                    environments. <strong className="text-foreground">extra</strong> keys are never
                    removed for you.
                  </p>
                </>
              ) : (
                <>
                  <Title>Nothing to compare yet.</Title>
                  <Lead>
                    {scan
                      ? 'That folder has fewer than two env files in one project. Pick a folder with a project that has, say, .env and .env.production, or continue and come back later.'
                      : 'Choose a folder in the previous step and the first receipt appears here.'}
                  </Lead>
                </>
              )}
            </>
          )}

          {step === 3 && (
            <>
              <Eyebrow>Step 3 · Agents · optional</Eyebrow>
              <Title>
                Give your coding agent the <span className="text-lemon-ink">shape</span>, not the
                secrets.
              </Title>
              <Lead>
                One click adds {PRODUCT}&apos;s MCP server to a client. Claude Code, Cursor and
                friends can then ask which keys a deploy is missing. They get key names and classes;
                there is no tool that returns a value or writes a file. Skip this if you do not use
                an agent.
              </Lead>
              <div className="mt-6" style={i(4)}>
                <McpClients />
              </div>
            </>
          )}

          {step === 4 && (
            <>
              <Eyebrow>Step 4 · How it works</Eyebrow>
              <Title>
                Three pages. <span className="text-lemon-ink">One</span> loop.
              </Title>
              <div className="mt-6 grid gap-3 sm:grid-cols-3">
                <Card n={4} icon={FolderSearch} title={`Workspace · ${MOD}1`}>
                  Projects on the left, environments per project, A and B pickers on each file.
                </Card>
                <Card n={5} icon={Receipt} title={`Receipt · ${MOD}2`}>
                  Classes per key, filters, search with {MOD}F, and the dry-run plan tab.
                </Card>
                <Card n={6} icon={History} title={`History · ${MOD}3`}>
                  Every grant, scan and comparison, redacted, on this machine only.
                </Card>
              </div>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <Card n={7} icon={Bot} title={`Agents · ${MOD}4`}>
                  Manage MCP clients and copy manual config.
                </Card>
                <Card n={8} icon={Keyboard} title="Shortcuts">
                  {MOD}B collapses the sidebar, {MOD}, opens Settings. Replay this tour from
                  Settings any time.
                </Card>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="relative z-10 flex h-16 shrink-0 items-center gap-3 border-t bg-background/70 px-8 backdrop-blur-sm">
        {step > 0 && (
          <Button variant="ghost" size="sm" onClick={back}>
            <ArrowLeft /> Back
          </Button>
        )}
        <span className="ml-auto" />
        {step < STEPS.length - 1 ? (
          <Button
            size="sm"
            className="press"
            onClick={next}
            disabled={step === 1 && (!scan || scanning)}
          >
            {step === 0 ? 'Start' : step === 3 ? 'Continue' : 'Next'} <ArrowRight />
          </Button>
        ) : (
          <Button
            size="sm"
            className="press cta-pulse"
            onClick={() => finish(receipt ? 'receipt' : 'workspace')}
          >
            {receipt ? 'Open my receipt' : 'Open Workspace'} <ArrowRight />
          </Button>
        )}
      </div>
    </div>
  )
}
