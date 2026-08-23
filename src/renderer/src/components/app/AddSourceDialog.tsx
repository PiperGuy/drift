import { useEffect, useState } from 'react'
import {
  Box,
  Cloud,
  Container,
  FolderOpen,
  KeyRound,
  Loader2,
  Server,
  Vault,
  type LucideIcon
} from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useWorkspace } from '@/store/workspace'
import { cn } from '@/lib/utils'

/**
 * A source is anywhere env values live. Local folders and SSH hosts (including
 * EC2 over SSH) work today; the rest show their configuration so the shape is
 * clear, and connect when their backend lands. Every source ends up as a root
 * in the active workspace.
 */
type SourceId = 'local' | 'ssh' | 'ec2' | 'ecs' | 'docker' | 'vault' | 'secretsmanager'

type Source = {
  id: SourceId
  label: string
  icon: LucideIcon
  blurb: string
  available: boolean
}

const SOURCES: Source[] = [
  {
    id: 'local',
    label: 'Local folder',
    icon: FolderOpen,
    blurb: 'A folder on this machine. Files stay where they are.',
    available: true
  },
  {
    id: 'ssh',
    label: 'SSH server',
    icon: Server,
    blurb: 'Any Linux host your ssh can reach: VPS, bare metal, jump hosts.',
    available: true
  },
  {
    id: 'ec2',
    label: 'EC2 instance',
    icon: Cloud,
    blurb: 'An instance over SSH using its public DNS or IP and your key.',
    available: true
  },
  {
    id: 'docker',
    label: 'Docker container',
    icon: Container,
    blurb: 'A running container, local or over SSH, read with docker exec.',
    available: false
  },
  {
    id: 'ecs',
    label: 'ECS container',
    icon: Box,
    blurb: 'A task container via ECS Exec (AWS credential chain).',
    available: false
  },
  {
    id: 'vault',
    label: 'HashiCorp Vault',
    icon: Vault,
    blurb: 'KV v2 paths as environments. Token sealed by the OS keyring.',
    available: false
  },
  {
    id: 'secretsmanager',
    label: 'AWS Secrets Manager',
    icon: KeyRound,
    blurb: 'JSON secrets as env files, per region, via your AWS profile.',
    available: false
  }
]

const err = (e: unknown): string =>
  e instanceof Error ? e.message.replace(/^.*Error: /, '') : String(e)

function Field({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <label className="block text-xs">
      <span className="text-muted-foreground">{label}</span>
      <div className="mt-1">{children}</div>
      {hint && <span className="mt-1 block text-[11px] text-muted-foreground/80">{hint}</span>}
    </label>
  )
}

/** Split ssh://user@host/path into the dialog's fields. */
function fromRoot(path: string | null | undefined): { kind: SourceId; f: Record<string, string> } {
  const m = path ? /^ssh:\/\/([^/]+)(\/.*)$/.exec(path) : null
  if (m) return { kind: 'ssh', f: { host: m[1], path: m[2], user: 'ubuntu', region: 'us-east-1' } }
  return { kind: 'local', f: { path: '/', user: 'ubuntu', region: 'us-east-1' } }
}

export function AddSourceDialog({
  onClose,
  mode = 'new'
}: {
  onClose: () => void
  /** 'edit' prefills from the active source; saving renames and, if changed, reconnects. */
  mode?: 'new' | 'edit'
}): React.JSX.Element {
  const { createSource, updateSource, workspaces, workspace, roots } = useWorkspace()
  const current = mode === 'edit' ? workspaces.find((w) => w.id === workspace) : undefined
  const seed = fromRoot(current?.path ?? roots[0]?.path)
  const [kind, setKind] = useState<SourceId>(mode === 'edit' ? seed.kind : 'local')
  const [name, setName] = useState(current?.name ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [f, setF] = useState<Record<string, string>>(
    mode === 'edit' ? seed.f : { path: '', user: 'ubuntu', region: 'us-east-1' }
  )
  const [repick, setRepick] = useState(false)
  const [aliases, setAliases] = useState<string[]>([])
  useEffect(() => {
    window.plumbr.sshHosts().then(setAliases)
  }, [])
  const set = (k: string, v: string): void => setF((x) => ({ ...x, [k]: v }))
  const src = SOURCES.find((s) => s.id === kind)!

  const spec = (): Parameters<typeof createSource>[0] => {
    if (kind === 'ssh')
      return { kind: 'ssh', name, host: f['host']?.trim() ?? '', path: f['path']?.trim() || '/' }
    if (kind === 'ec2')
      return {
        kind: 'ssh',
        name,
        host: `${f['user']?.trim() || 'ubuntu'}@${f['host']?.trim() ?? ''}`,
        path: f['path']?.trim() || '/'
      }
    return { kind: 'local', name }
  }

  const connect = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      if (mode === 'edit') {
        const s = spec()
        await updateSource(s.kind === 'local' && !repick ? { kind: 'rename', name } : s)
      } else {
        await createSource(spec())
      }
      onClose()
    } catch (e) {
      setError(err(e))
    } finally {
      setBusy(false)
    }
  }

  const ready =
    kind === 'local' ||
    ((kind === 'ssh' || kind === 'ec2') &&
      Boolean(f['host']?.trim()) &&
      (f['path'] ?? '').startsWith('/'))

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="p-0 sm:max-w-3xl">
        <div className="grid grid-cols-[14rem_1fr]">
          <aside className="border-r bg-sidebar p-2" aria-label="Source types">
            <p className="px-2 pt-1 pb-2 text-[10px] font-medium tracking-widest text-muted-foreground uppercase">
              {mode === 'edit' ? 'Update source' : 'Add a source'}
            </p>
            {SOURCES.map((s) => (
              <button
                key={s.id}
                type="button"
                aria-current={kind === s.id ? 'true' : undefined}
                onClick={() => {
                  setKind(s.id)
                  setError(null)
                }}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors duration-(--duration-fast)',
                  kind === s.id
                    ? 'bg-sidebar-accent font-medium'
                    : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground'
                )}
              >
                <s.icon
                  className={cn('size-4 shrink-0', kind === s.id && 'text-lemon-ink')}
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1 truncate">{s.label}</span>
                {!s.available && (
                  <span className="font-mono text-[9px] tracking-wide text-muted-foreground uppercase">
                    soon
                  </span>
                )}
              </button>
            ))}
          </aside>

          <form
            className="p-5"
            onSubmit={(e) => {
              e.preventDefault()
              if (ready && src.available) void connect()
            }}
          >
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <src.icon className="size-4 text-lemon-ink" /> {src.label}
                {!src.available && (
                  <span className="rounded-sm border border-warn/30 bg-warn-soft px-1.5 py-0.5 font-mono text-[10px] tracking-wide text-warn uppercase">
                    coming soon
                  </span>
                )}
              </DialogTitle>
              <DialogDescription>{src.blurb}</DialogDescription>
            </DialogHeader>

            <fieldset className="mt-4 space-y-3" disabled={!src.available || busy}>
              <Field
                label="Name"
                hint="How it shows in the source switcher. Leave empty to use the folder or host name."
              >
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={kind === 'local' ? 'e.g. Work laptop' : 'e.g. Production VPS'}
                  className="h-8 text-xs"
                  autoComplete="off"
                />
              </Field>
              {kind === 'local' && mode === 'edit' && (
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    className="accent-(--lemon-ink)"
                    checked={repick}
                    onChange={(e) => setRepick(e.target.checked)}
                  />
                  Choose a different directory
                </label>
              )}
              {kind === 'local' && (
                <p className="text-xs text-muted-foreground">
                  The OS folder picker opens. Drift walks the folder, skips{' '}
                  <code className="font-mono">node_modules</code>,{' '}
                  <code className="font-mono">.git</code> and build output, and groups env files by
                  Git repository. Only this folder becomes readable.
                </p>
              )}
              {(kind === 'ssh' || kind === 'ec2') && (
                <>
                  {kind === 'ec2' ? (
                    <>
                      <Field
                        label="Public DNS or IP"
                        hint="From the EC2 console. Port 22 must be open to you."
                      >
                        <Input
                          value={f['host'] ?? ''}
                          onChange={(e) => set('host', e.target.value)}
                          placeholder="ec2-3-250-1-2.eu-west-1.compute.amazonaws.com"
                          className="h-8 font-mono text-xs"
                          spellCheck={false}
                          autoComplete="off"
                          autoFocus
                        />
                      </Field>
                      <Field label="User" hint="ubuntu for Ubuntu AMIs, ec2-user for Amazon Linux.">
                        <Input
                          value={f['user'] ?? ''}
                          onChange={(e) => set('user', e.target.value)}
                          className="h-8 font-mono text-xs"
                          spellCheck={false}
                          autoComplete="off"
                        />
                      </Field>
                    </>
                  ) : (
                    <Field
                      label="Host"
                      hint={
                        aliases.length
                          ? 'An alias from ~/.ssh/config (suggested below), or user@host. Aliases carry their key and user.'
                          : 'Anything ssh accepts: user@host, or an alias from ~/.ssh/config.'
                      }
                    >
                      <Input
                        value={f['host'] ?? ''}
                        onChange={(e) => set('host', e.target.value)}
                        placeholder="deploy@vps.example.com"
                        className="h-8 font-mono text-xs"
                        spellCheck={false}
                        autoComplete="off"
                        list="ssh-aliases"
                        autoFocus
                      />
                      <datalist id="ssh-aliases">
                        {aliases.map((a) => (
                          <option key={a} value={a} />
                        ))}
                      </datalist>
                      {aliases.length > 0 && (
                        <div className="mt-1.5 flex flex-wrap gap-1">
                          {aliases.slice(0, 8).map((a) => (
                            <button
                              key={a}
                              type="button"
                              onClick={() => set('host', a)}
                              className="rounded-md border bg-muted px-1.5 py-0.5 font-mono text-[11px] hover:bg-accent"
                            >
                              {a}
                            </button>
                          ))}
                        </div>
                      )}
                    </Field>
                  )}
                  <Field
                    label="Directory on the server"
                    hint="Absolute path. Drift reads only inside it."
                  >
                    <Input
                      value={f['path'] ?? ''}
                      onChange={(e) => set('path', e.target.value)}
                      placeholder="/home/deploy/apps  (absolute path)"
                      className="h-8 font-mono text-xs"
                      spellCheck={false}
                      autoComplete="off"
                    />
                  </Field>
                  <p className="text-[11px] text-muted-foreground">
                    Uses the <code className="font-mono">ssh</code> on this machine: your keys,
                    agent and known_hosts apply, no password prompts, nothing stored by Drift. Linux
                    with GNU coreutils on the other end.
                  </p>
                </>
              )}
              {kind === 'docker' && (
                <>
                  <Field
                    label="Docker host"
                    hint="Leave empty for the local daemon, or ssh://user@host."
                  >
                    <Input
                      value={f['dockerHost'] ?? ''}
                      onChange={(e) => set('dockerHost', e.target.value)}
                      placeholder="ssh://deploy@vps.example.com"
                      className="h-8 font-mono text-xs"
                    />
                  </Field>
                  <Field label="Container">
                    <Input
                      value={f['container'] ?? ''}
                      onChange={(e) => set('container', e.target.value)}
                      placeholder="api-1"
                      className="h-8 font-mono text-xs"
                    />
                  </Field>
                  <Field label="Directory in the container">
                    <Input
                      value={f['path'] ?? ''}
                      onChange={(e) => set('path', e.target.value)}
                      placeholder="/app"
                      className="h-8 font-mono text-xs"
                    />
                  </Field>
                </>
              )}
              {kind === 'ecs' && (
                <>
                  <Field label="Region">
                    <Input
                      value={f['region'] ?? ''}
                      onChange={(e) => set('region', e.target.value)}
                      className="h-8 font-mono text-xs"
                    />
                  </Field>
                  <Field label="Cluster">
                    <Input
                      value={f['cluster'] ?? ''}
                      onChange={(e) => set('cluster', e.target.value)}
                      placeholder="prod"
                      className="h-8 font-mono text-xs"
                    />
                  </Field>
                  <Field label="Service or task" hint="ECS Exec must be enabled on the task.">
                    <Input
                      value={f['service'] ?? ''}
                      onChange={(e) => set('service', e.target.value)}
                      placeholder="api"
                      className="h-8 font-mono text-xs"
                    />
                  </Field>
                  <Field label="Container and directory">
                    <Input
                      value={f['path'] ?? ''}
                      onChange={(e) => set('path', e.target.value)}
                      placeholder="api:/app"
                      className="h-8 font-mono text-xs"
                    />
                  </Field>
                </>
              )}
              {kind === 'vault' && (
                <>
                  <Field label="Address">
                    <Input
                      value={f['addr'] ?? ''}
                      onChange={(e) => set('addr', e.target.value)}
                      placeholder="https://vault.example.com:8200"
                      className="h-8 font-mono text-xs"
                    />
                  </Field>
                  <Field label="Namespace" hint="Enterprise / HCP only; leave empty otherwise.">
                    <Input
                      value={f['ns'] ?? ''}
                      onChange={(e) => set('ns', e.target.value)}
                      className="h-8 font-mono text-xs"
                    />
                  </Field>
                  <Field label="KV v2 mount and path" hint="Each path becomes an environment.">
                    <Input
                      value={f['vpath'] ?? ''}
                      onChange={(e) => set('vpath', e.target.value)}
                      placeholder="secret/apps/api"
                      className="h-8 font-mono text-xs"
                    />
                  </Field>
                  <Field
                    label="Token"
                    hint="Sealed by the OS keyring, only if you opt in. Never written in the clear."
                  >
                    <Input
                      type="password"
                      value={f['token'] ?? ''}
                      onChange={(e) => set('token', e.target.value)}
                      className="h-8 font-mono text-xs"
                      autoComplete="off"
                    />
                  </Field>
                </>
              )}
              {kind === 'secretsmanager' && (
                <>
                  <Field label="Region">
                    <Input
                      value={f['region'] ?? ''}
                      onChange={(e) => set('region', e.target.value)}
                      className="h-8 font-mono text-xs"
                    />
                  </Field>
                  <Field
                    label="AWS profile"
                    hint="Standard credential chain: profiles, SSO, env. Drift stores no AWS keys."
                  >
                    <Input
                      value={f['profile'] ?? ''}
                      onChange={(e) => set('profile', e.target.value)}
                      placeholder="default"
                      className="h-8 font-mono text-xs"
                    />
                  </Field>
                  <Field label="Secret name or prefix" hint="A JSON secret maps to one env file.">
                    <Input
                      value={f['secret'] ?? ''}
                      onChange={(e) => set('secret', e.target.value)}
                      placeholder="prod/api"
                      className="h-8 font-mono text-xs"
                    />
                  </Field>
                </>
              )}
            </fieldset>

            {error && (
              <p
                role="alert"
                className="mt-3 rounded-md border border-bad/30 bg-bad-soft px-3 py-2 text-xs text-bad"
              >
                {error}
              </p>
            )}
            <div className="mt-5 flex items-center justify-end gap-2">
              <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
                Cancel
              </Button>
              <Button type="submit" className="press" disabled={!src.available || !ready || busy}>
                {busy ? (
                  <Loader2 className="animate-spin motion-reduce:animate-none" />
                ) : (
                  <src.icon />
                )}
                {!src.available
                  ? 'Coming soon'
                  : mode === 'edit'
                    ? busy
                      ? 'Saving'
                      : 'Save'
                    : kind === 'local'
                      ? 'Choose directory'
                      : busy
                        ? 'Connecting'
                        : 'Connect and scan'}
              </Button>
            </div>
          </form>
        </div>
      </DialogContent>
    </Dialog>
  )
}
