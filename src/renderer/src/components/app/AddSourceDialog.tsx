import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useWorkspace, type SourceSpec } from '@/store/workspace'
import { VaultGuide } from '@/components/app/VaultGuide'
import { SourceIcon } from '@/components/app/SourceIcon'
import { cn } from '@/lib/utils'
import type { EcsDiscovery, ProviderConnectSpec, RootInfo, RootKind } from '@shared/channels'

/**
 * A source is anywhere env values live. Local folders, SSH hosts (including EC2
 * over SSH) and Docker containers are file sources: read, compare and write.
 * Vault is a versioned document store with check-and-set writes. Everything
 * else (ECS, AWS Secrets Manager, GitHub Actions, Vercel, Railway, Render,
 * Dokploy, Coolify) is read-only: Drift reads with your own credentials, from
 * this machine, and never writes back. Every source ends up as a root in the
 * active workspace.
 */
type SourceId = RootKind | 'ec2'

type Source = { id: SourceId; kind: RootKind; label: string; blurb: string; readOnly?: boolean }

const SOURCES: Source[] = [
  {
    id: 'local',
    kind: 'local',
    label: 'Local folder',
    blurb: 'A folder on this machine. Files stay where they are.'
  },
  {
    id: 'ssh',
    kind: 'ssh',
    label: 'SSH server',
    blurb: 'Any Linux host your ssh can reach: VPS, bare metal, jump hosts.'
  },
  {
    id: 'ec2',
    kind: 'ssh',
    label: 'EC2 instance',
    blurb: 'An instance over SSH using its public DNS or IP and your key.'
  },
  {
    id: 'docker',
    kind: 'docker',
    label: 'Docker container',
    blurb: 'A running container, local or on an ssh daemon host, read with docker exec.'
  },
  {
    id: 'ecs',
    kind: 'ecs',
    label: 'ECS container',
    blurb:
      'A task container: its task-definition environment through the API, or files inside it with ECS Exec. AWS credential chain, read-only.',
    readOnly: true
  },
  {
    id: 'aws-sm',
    kind: 'aws-sm',
    label: 'AWS Secrets Manager',
    blurb: 'JSON secrets as env files, per region, via your AWS profile. Read-only.',
    readOnly: true
  },
  {
    id: 'vault',
    kind: 'vault',
    label: 'HashiCorp Vault',
    blurb: 'KV v2 secrets as environments, with version history. Writes are check-and-set guarded.'
  },
  {
    id: 'github',
    kind: 'github',
    label: 'GitHub Actions',
    blurb:
      'Repository, environment and organization variables and secrets. Secrets are names only: GitHub never returns their values.',
    readOnly: true
  },
  {
    id: 'vercel',
    kind: 'vercel',
    label: 'Vercel',
    blurb:
      'Project environment variables per target and branch. Sensitive variables are names only.',
    readOnly: true
  },
  {
    id: 'railway',
    kind: 'railway',
    label: 'Railway',
    blurb: 'Shared and per-service variables for every environment of a project.',
    readOnly: true
  },
  {
    id: 'render',
    kind: 'render',
    label: 'Render',
    blurb: 'Environment groups and service variables visible to an API key.',
    readOnly: true
  },
  {
    id: 'dokploy',
    kind: 'dokploy',
    label: 'Dokploy',
    blurb: 'Application variables on a self-hosted instance. Custom CA supported.',
    readOnly: true
  },
  {
    id: 'coolify',
    kind: 'coolify',
    label: 'Coolify',
    blurb:
      'Application variables (and preview-deployment variables) on a self-hosted instance. Custom CA supported.',
    readOnly: true
  }
]

const REGION = /^[a-z]{2}(-[a-z]+)+-\d$/
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

const mono = 'h-8 font-mono text-xs'

/** Suggestion chips under a field (aliases, containers, clusters …). */
function Chips({
  items,
  onPick,
  max = 8
}: {
  items: string[]
  onPick: (v: string) => void
  max?: number
}): React.JSX.Element | null {
  if (items.length === 0) return null
  return (
    <div className="mt-1.5 flex flex-wrap gap-1">
      {items.slice(0, max).map((a) => (
        <button
          key={a}
          type="button"
          onClick={() => onPick(a)}
          className="rounded-md border bg-muted px-1.5 py-0.5 font-mono text-[11px] hover:bg-accent"
        >
          {a}
        </button>
      ))}
    </div>
  )
}

/** Split a root ref into the dialog's fields for Update source. Credentials are never recoverable. */
function fromRoot(root: RootInfo | null | undefined): {
  kind: SourceId
  f: Record<string, string>
} {
  const path = root?.path
  const base = { user: 'ubuntu', region: 'us-east-1' }
  const v = path ? /^vault:\/\/\d+\/([^/]+)\/(.+)$/.exec(path) : null
  if (v) return { kind: 'vault', f: { ...base, vpath: `${decodeURIComponent(v[1])}/${v[2]}` } }
  const d = path ? /^docker:\/\/([^/]*)\/([^/]+)(\/.*)$/.exec(path) : null
  if (d) return { kind: 'docker', f: { ...base, dockerHost: d[1], container: d[2], path: d[3] } }
  const m = path ? /^ssh:\/\/([^/]+)(\/.*)$/.exec(path) : null
  if (m) return { kind: 'ssh', f: { ...base, host: m[1], path: m[2] } }
  const p = path ? /^([a-z-]+):\/\/\d+(?:\/(.*))?$/.exec(path) : null
  if (p) {
    const rest = p[2] ?? ''
    const f: Record<string, string> = { ...base }
    if (p[1] === 'github') {
      const [owner, repo] = rest.split('/')
      f['owner'] = owner ?? ''
      f['repo'] = repo ?? ''
    } else if (p[1] === 'vercel' || p[1] === 'railway') f['project'] = rest
    // The ref strips the slash; main says whether this is a folder of secrets.
    else if (p[1] === 'aws-sm') f['secret'] = root?.prefix ? `${rest}/` : rest
    else if (p[1] === 'ecs') {
      const [cluster, selector, container, fs, ...dir] = rest.split('/')
      Object.assign(f, {
        cluster: cluster ?? '',
        selector: selector ?? '',
        container: container ?? '',
        ecsPath: fs === 'fs' ? '/' + dir.join('/') : ''
      })
    }
    return { kind: p[1] as SourceId, f }
  }
  return { kind: 'local', f: { ...base, path: '/' } }
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
  const seed = fromRoot(roots.find((r) => r.path === current?.path) ?? roots[0])
  const [kind, setKind] = useState<SourceId>(mode === 'edit' ? seed.kind : 'local')
  const [name, setName] = useState(current?.name ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const DEFAULTS = { path: '', user: 'ubuntu', region: 'us-east-1' }
  const [f, setF] = useState<Record<string, string>>(mode === 'edit' ? seed.f : DEFAULTS)
  const [repick, setRepick] = useState(false)
  const [aliases, setAliases] = useState<string[]>([])
  const [profiles, setProfiles] = useState<string[]>([])
  const [containers, setContainers] = useState<string[]>([])
  const [ecs, setEcs] = useState<EcsDiscovery | null>(null)
  const [looking, setLooking] = useState(false)
  useEffect(() => {
    window.plumbr.sshHosts().then(setAliases)
    window.plumbr
      .awsProfiles()
      .then(setProfiles)
      .catch(() => {})
  }, [])
  const set = (k: string, v: string): void => setF((x) => ({ ...x, [k]: v }))
  const g = (k: string): string => f[k]?.trim() ?? ''
  const src = SOURCES.find((s) => s.id === kind)!
  const storage = f['keep'] === '1' ? 'keychain' : 'session'

  /** One IPC call for suggestions; the result only fills chips, never the fields. */
  const lookup = async (run: () => Promise<void>): Promise<void> => {
    setLooking(true)
    setError(null)
    try {
      await run()
    } catch (e) {
      setError(err(e))
    } finally {
      setLooking(false)
    }
  }

  const provider = (): ProviderConnectSpec | null => {
    const profile = g('profile') || undefined
    switch (kind) {
      case 'ecs':
        return {
          provider: 'ecs',
          name,
          region: g('region'),
          profile,
          cluster: g('cluster'),
          selector: g('selector'),
          container: g('container'),
          path: g('ecsPath') || undefined
        }
      case 'aws-sm':
        return { provider: 'aws-sm', name, region: g('region'), profile, secret: g('secret') }
      case 'github':
        return {
          provider: 'github',
          name,
          token: f['token'] ?? '',
          owner: g('owner'),
          repo: g('repo') || undefined,
          storage
        }
      case 'vercel':
        return {
          provider: 'vercel',
          name,
          token: f['token'] ?? '',
          project: g('project'),
          teamId: g('teamId') || undefined,
          storage
        }
      case 'railway':
        return {
          provider: 'railway',
          name,
          token: f['token'] ?? '',
          project: g('project'),
          storage
        }
      case 'render':
        return { provider: 'render', name, token: f['token'] ?? '', storage }
      case 'dokploy':
      case 'coolify':
        return {
          provider: kind,
          name,
          token: f['token'] ?? '',
          address: g('addr'),
          caPem: g('ca') || undefined,
          storage
        }
      default:
        return null
    }
  }

  const spec = (): SourceSpec => {
    if (kind === 'ssh') return { kind: 'ssh', name, host: g('host'), path: g('path') || '/' }
    if (kind === 'ec2')
      return {
        kind: 'ssh',
        name,
        host: `${g('user') || 'ubuntu'}@${g('host')}`,
        path: g('path') || '/'
      }
    if (kind === 'docker')
      return {
        kind: 'docker',
        name,
        host: g('dockerHost') || undefined,
        container: g('container'),
        path: g('path') || '/'
      }
    if (kind === 'vault')
      return {
        kind: 'vault',
        name,
        address: g('addr'),
        namespace: g('ns') || undefined,
        caPem: g('ca') || undefined,
        path: g('vpath'),
        auth:
          (f['auth'] ?? 'token') === 'approle'
            ? { kind: 'approle', roleId: g('roleId'), secretId: f['secretId'] ?? '' }
            : { kind: 'token', token: f['token'] ?? '' },
        storage
      }
    const p = provider()
    if (p) return { kind: 'provider', name, spec: p }
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

  const token = Boolean(f['token'])
  const https = /^https?:\/\//.test(g('addr'))
  const ready = ((): boolean => {
    switch (kind) {
      case 'local':
        return true
      case 'ssh':
      case 'ec2':
        return Boolean(g('host')) && (f['path'] ?? '').startsWith('/')
      case 'docker':
        return (
          /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(g('container')) && (f['path'] ?? '').startsWith('/')
        )
      case 'vault':
        return (
          https &&
          Boolean(g('vpath')) &&
          ((f['auth'] ?? 'token') === 'approle'
            ? Boolean(g('roleId')) && Boolean(f['secretId'])
            : token)
        )
      case 'ecs':
        return (
          REGION.test(g('region')) &&
          Boolean(g('cluster')) &&
          /^(service|task):.+/.test(g('selector')) &&
          Boolean(g('container')) &&
          (g('ecsPath') === '' || g('ecsPath').startsWith('/'))
        )
      case 'aws-sm':
        return REGION.test(g('region')) && Boolean(g('secret'))
      case 'github':
        return Boolean(g('owner')) && token
      case 'vercel':
      case 'railway':
        return Boolean(g('project')) && token
      case 'render':
        return token
      case 'dokploy':
      case 'coolify':
        return https && token
    }
  })()

  const awsFields = (
    <div className="grid gap-3 @lg:grid-cols-2">
      <Field label="Region" hint="e.g. eu-west-1">
        <Input
          value={f['region'] ?? ''}
          onChange={(e) => set('region', e.target.value)}
          className={mono}
          spellCheck={false}
          autoComplete="off"
        />
      </Field>
      <Field
        label="AWS profile"
        hint="Standard credential chain: profiles, SSO, env. Drift stores the profile name only, never a key."
      >
        <Input
          value={f['profile'] ?? ''}
          onChange={(e) => set('profile', e.target.value)}
          placeholder="default"
          className={mono}
          spellCheck={false}
          autoComplete="off"
          list="aws-profiles"
        />
        <datalist id="aws-profiles">
          {profiles.map((p) => (
            <option key={p} value={p} />
          ))}
        </datalist>
        <Chips items={profiles} onPick={(p) => set('profile', p)} />
      </Field>
    </div>
  )

  const tokenField = (label: string, hint: string): React.JSX.Element => (
    <>
      <Field label={label} hint={hint}>
        <Input
          type="password"
          value={f['token'] ?? ''}
          onChange={(e) => set('token', e.target.value)}
          className={mono}
          autoComplete="off"
        />
      </Field>
      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          className="accent-(--lemon-ink)"
          checked={f['keep'] === '1'}
          onChange={(e) => set('keep', e.target.checked ? '1' : '')}
        />
        Save the token in the OS keyring (unticked: kept for this session only)
      </label>
    </>
  )

  const caField = (
    <Field
      label="CA certificate (optional)"
      hint="PEM bundle for a self-signed instance. Not a secret."
    >
      <textarea
        value={f['ca'] ?? ''}
        onChange={(e) => set('ca', e.target.value)}
        placeholder="-----BEGIN CERTIFICATE-----"
        rows={2}
        spellCheck={false}
        className="w-full min-w-0 resize-y rounded-md border bg-transparent px-2 py-1 font-mono text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
    </Field>
  )

  const addressField = (placeholder: string): React.JSX.Element => (
    <Field label="Instance URL" hint="https:// — plain http only for an instance on this machine.">
      <Input
        value={f['addr'] ?? ''}
        onChange={(e) => set('addr', e.target.value)}
        placeholder={placeholder}
        className={mono}
        spellCheck={false}
        autoComplete="off"
        autoFocus
      />
    </Field>
  )

  const readOnlyNote = (
    <p className="text-[11px] text-muted-foreground">
      Read-only: Drift calls the API from this machine with your credentials, renders redacted
      shapes and never writes back. Compare against files, then change values in the provider
      itself.
    </p>
  )

  const selectedContainers =
    ecs?.services.find((s) => `service:${s.name}` === g('selector'))?.containers ??
    ecs?.tasks.find((t) => `task:${t.id}` === g('selector'))?.containers ??
    []

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="h-[min(36rem,calc(100dvh-2rem))] grid-rows-[minmax(0,1fr)] overflow-hidden p-0 sm:max-w-3xl">
        <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] sm:grid-cols-[13rem_minmax(0,1fr)] sm:grid-rows-[minmax(0,1fr)]">
          <aside
            className="min-w-0 border-b bg-sidebar p-2 sm:overflow-y-auto sm:border-r sm:border-b-0"
            aria-label="Source types"
          >
            <p className="px-2 pt-1 pb-2 text-[10px] font-medium tracking-widest text-muted-foreground uppercase">
              {mode === 'edit' ? 'Update source' : 'Add a source'}
            </p>
            <div className="flex gap-1 overflow-x-auto pb-1 sm:block sm:space-y-0 sm:pb-0">
              {SOURCES.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  aria-current={kind === s.id ? 'true' : undefined}
                  onClick={() => {
                    setKind(s.id)
                    setError(null)
                    // A token pasted for one provider must never be reused for another.
                    setF(mode === 'edit' && s.id === seed.kind ? seed.f : DEFAULTS)
                  }}
                  className={cn(
                    'flex shrink-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] whitespace-nowrap transition-colors duration-(--duration-fast) sm:w-full sm:whitespace-normal',
                    kind === s.id
                      ? 'bg-sidebar-accent font-medium'
                      : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground'
                  )}
                >
                  <SourceIcon
                    kind={s.kind}
                    className={cn('size-4 shrink-0', kind === s.id && 'text-lemon-ink')}
                  />
                  <span className="min-w-0 flex-1 truncate">{s.label}</span>
                  {s.readOnly && (
                    <span
                      className="font-mono text-[9px] tracking-wide text-muted-foreground uppercase"
                      title="Read-only source"
                    >
                      read
                    </span>
                  )}
                </button>
              ))}
            </div>
          </aside>

          <form
            className="@container min-h-0 overflow-y-auto p-5"
            onSubmit={(e) => {
              e.preventDefault()
              if (ready) void connect()
            }}
          >
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <SourceIcon kind={src.kind} className="size-4 text-lemon-ink" /> {src.label}
                {kind === 'vault' && <VaultGuide className="-my-1" />}
                {src.readOnly && (
                  <span className="rounded-sm border px-1.5 py-0.5 font-mono text-[10px] tracking-wide text-muted-foreground uppercase">
                    read-only
                  </span>
                )}
              </DialogTitle>
              <DialogDescription>{src.blurb}</DialogDescription>
            </DialogHeader>

            <fieldset className="mt-4 space-y-3" disabled={busy}>
              <Field
                label="Name"
                hint="How it shows in the source switcher. Leave empty to use the folder, host or project name."
              >
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={kind === 'local' ? 'e.g. Work laptop' : 'e.g. Production'}
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
                          className={mono}
                          spellCheck={false}
                          autoComplete="off"
                          autoFocus
                        />
                      </Field>
                      <Field label="User" hint="ubuntu for Ubuntu AMIs, ec2-user for Amazon Linux.">
                        <Input
                          value={f['user'] ?? ''}
                          onChange={(e) => set('user', e.target.value)}
                          className={mono}
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
                        className={mono}
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
                      <Chips items={aliases} onPick={(a) => set('host', a)} />
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
                      className={mono}
                      spellCheck={false}
                      autoComplete="off"
                    />
                  </Field>
                  <p className="text-[11px] text-muted-foreground">
                    Uses the <code className="font-mono">ssh</code> on this machine: your keys,
                    agent and known_hosts apply, no password prompts, nothing stored by Drift.
                    {kind === 'ec2' &&
                      ' The key pair you chose when launching the instance must be loaded in your agent (or have no passphrase); Drift never touches AWS credentials for this.'}{' '}
                    Linux with GNU coreutils on the other end.
                  </p>
                </>
              )}
              {kind === 'docker' && (
                <>
                  <Field
                    label="Docker host"
                    hint="Leave empty for the local daemon, or user@host for a daemon reached over ssh (docker -H ssh://…)."
                  >
                    <Input
                      value={f['dockerHost'] ?? ''}
                      onChange={(e) => set('dockerHost', e.target.value)}
                      placeholder="deploy@vps.example.com"
                      className={mono}
                      spellCheck={false}
                      autoComplete="off"
                      list="ssh-aliases"
                    />
                    <datalist id="ssh-aliases">
                      {aliases.map((a) => (
                        <option key={a} value={a} />
                      ))}
                    </datalist>
                  </Field>
                  <Field
                    label="Container"
                    hint="Name as `docker ps` shows it. It must be running and have `sh`."
                  >
                    <Input
                      value={f['container'] ?? ''}
                      onChange={(e) => set('container', e.target.value)}
                      placeholder="api-1"
                      className={mono}
                      spellCheck={false}
                      autoComplete="off"
                      list="docker-containers"
                      autoFocus
                    />
                    <datalist id="docker-containers">
                      {containers.map((c) => (
                        <option key={c} value={c} />
                      ))}
                    </datalist>
                    <Chips items={containers} onPick={(c) => set('container', c)} />
                  </Field>
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    disabled={looking}
                    onClick={() =>
                      lookup(async () =>
                        setContainers(
                          await window.plumbr.dockerContainers(g('dockerHost') || undefined)
                        )
                      )
                    }
                  >
                    {looking ? <Loader2 className="animate-spin" /> : null} List running containers
                  </Button>
                  <Field
                    label="Directory in the container"
                    hint="Absolute path. Drift reads only inside it."
                  >
                    <Input
                      value={f['path'] ?? ''}
                      onChange={(e) => set('path', e.target.value)}
                      placeholder="/app"
                      className={mono}
                      spellCheck={false}
                      autoComplete="off"
                    />
                  </Field>
                  <p className="text-[11px] text-muted-foreground">
                    Uses the <code className="font-mono">docker</code> CLI on this machine (
                    <code className="font-mono">docker exec … sh -c</code>). Reads, compares, edits
                    and formats work like on an SSH host: writes are temp file + rename with the
                    same mtime guard. Nothing is stored by Drift.
                  </p>
                </>
              )}
              {kind === 'ecs' && (
                <>
                  {awsFields}
                  <Field label="Cluster">
                    <Input
                      value={f['cluster'] ?? ''}
                      onChange={(e) => set('cluster', e.target.value)}
                      placeholder="prod"
                      className={mono}
                      spellCheck={false}
                      autoComplete="off"
                      list="ecs-clusters"
                    />
                    <datalist id="ecs-clusters">
                      {(ecs?.clusters ?? []).map((c) => (
                        <option key={c} value={c} />
                      ))}
                    </datalist>
                    <Chips items={ecs?.clusters ?? []} onPick={(c) => set('cluster', c)} />
                  </Field>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      disabled={looking || !REGION.test(g('region'))}
                      onClick={() =>
                        lookup(async () =>
                          setEcs(
                            await window.plumbr.ecsDiscover({
                              region: g('region'),
                              profile: g('profile') || undefined
                            })
                          )
                        )
                      }
                    >
                      List clusters
                    </Button>
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      disabled={looking || !REGION.test(g('region')) || !g('cluster')}
                      onClick={() =>
                        lookup(async () =>
                          setEcs(
                            await window.plumbr.ecsDiscover({
                              region: g('region'),
                              profile: g('profile') || undefined,
                              cluster: g('cluster')
                            })
                          )
                        )
                      }
                    >
                      {looking ? <Loader2 className="animate-spin" /> : null} List services and
                      tasks
                    </Button>
                  </div>
                  <Field
                    label="Service or task"
                    hint="service:<name> follows deployments (recommended); task:<id> pins one task."
                  >
                    <Input
                      value={f['selector'] ?? ''}
                      onChange={(e) => set('selector', e.target.value)}
                      placeholder="service:api"
                      className={mono}
                      spellCheck={false}
                      autoComplete="off"
                    />
                    <Chips
                      items={[
                        ...(ecs?.services ?? []).map((s) => `service:${s.name}`),
                        ...(ecs?.tasks ?? []).map((t) => `task:${t.id}`)
                      ]}
                      onPick={(v) => set('selector', v)}
                      max={12}
                    />
                    {ecs && ecs.services.length + ecs.tasks.length > 0 && (
                      <ul className="mt-1 space-y-0.5 font-mono text-[10px] text-muted-foreground">
                        {ecs.services.map((s) => (
                          <li key={s.name}>
                            service:{s.name} · {s.taskDefinition} · {s.running} running ·{' '}
                            {s.containers.join(', ')}
                          </li>
                        ))}
                        {ecs.tasks.map((t) => (
                          <li key={t.id}>
                            task:{t.id} · {t.family} · {t.lastStatus} · {t.containers.join(', ')}
                          </li>
                        ))}
                      </ul>
                    )}
                  </Field>
                  <Field label="Container">
                    <Input
                      value={f['container'] ?? ''}
                      onChange={(e) => set('container', e.target.value)}
                      placeholder="api"
                      className={mono}
                      spellCheck={false}
                      autoComplete="off"
                    />
                    <Chips items={selectedContainers} onPick={(c) => set('container', c)} />
                  </Field>
                  <Field
                    label="Directory in the container (optional, ECS Exec)"
                    hint="Empty: read the task definition's environment through the API; no command runs. Set: read .env files under this directory inside the RUNNING container with `aws ecs execute-command` on every scan (needs AWS CLI v2, the Session Manager plugin, enableExecuteCommand and ecs:ExecuteCommand)."
                  >
                    <Input
                      value={f['ecsPath'] ?? ''}
                      onChange={(e) => set('ecsPath', e.target.value)}
                      placeholder="/app"
                      className={mono}
                      spellCheck={false}
                      autoComplete="off"
                    />
                  </Field>
                  <p className="text-[11px] text-muted-foreground">
                    Task-definition mode shows <code className="font-mono">environment</code>{' '}
                    values; keys from <code className="font-mono">secrets</code> resolve inside the
                    task, so the API returns their names only and they compare as unknown. Add the
                    secret itself as an AWS Secrets Manager source to compare values.
                  </p>
                  {readOnlyNote}
                </>
              )}
              {kind === 'aws-sm' && (
                <>
                  {awsFields}
                  <Field
                    label="Secret name or prefix"
                    hint="One JSON secret becomes one env file; a prefix ending in / makes each JSON secret under it a file. Binary and non-object secrets are refused."
                  >
                    <Input
                      value={f['secret'] ?? ''}
                      onChange={(e) => set('secret', e.target.value)}
                      placeholder="prod/api"
                      className={mono}
                      spellCheck={false}
                      autoComplete="off"
                      autoFocus
                    />
                  </Field>
                  {readOnlyNote}
                </>
              )}
              {kind === 'vault' && (
                <>
                  <div className="grid gap-3 @lg:grid-cols-[3fr_2fr]">
                    <Field
                      label="Address"
                      hint="Same as VAULT_ADDR. https:// — plain http only for a local Vault Proxy."
                    >
                      <Input
                        value={f['addr'] ?? ''}
                        onChange={(e) => set('addr', e.target.value)}
                        placeholder="https://vault.example.com:8200"
                        className={mono}
                        spellCheck={false}
                        autoComplete="off"
                        autoFocus
                      />
                    </Field>
                    <Field
                      label="Namespace"
                      hint='Enterprise / HCP only. HCP Vault Dedicated: usually "admin".'
                    >
                      <Input
                        value={f['ns'] ?? ''}
                        onChange={(e) => set('ns', e.target.value)}
                        className={mono}
                        spellCheck={false}
                        autoComplete="off"
                      />
                    </Field>
                  </div>
                  <Field
                    label="KV v2 path (mount included)"
                    hint="A secret document becomes one environment; point at a folder and each secret inside becomes one."
                  >
                    <Input
                      value={f['vpath'] ?? ''}
                      onChange={(e) => set('vpath', e.target.value)}
                      placeholder="secret/apps/api"
                      className={mono}
                      spellCheck={false}
                      autoComplete="off"
                    />
                  </Field>
                  <div
                    className="inline-flex rounded-md border p-0.5"
                    role="tablist"
                    aria-label="Authentication"
                  >
                    {(['token', 'approle'] as const).map((a) => (
                      <button
                        key={a}
                        type="button"
                        role="tab"
                        aria-selected={(f['auth'] ?? 'token') === a}
                        onClick={() => set('auth', a)}
                        className={cn(
                          'h-6 rounded-sm px-2.5 text-[11px] uppercase transition-colors duration-(--duration-fast)',
                          (f['auth'] ?? 'token') === a
                            ? 'bg-accent font-medium'
                            : 'text-muted-foreground hover:text-foreground'
                        )}
                      >
                        {a === 'token' ? 'Token' : 'AppRole'}
                      </button>
                    ))}
                  </div>
                  {(f['auth'] ?? 'token') === 'token' ? (
                    <Field
                      label="Token"
                      hint="From `vault login` or your admin. A wrapping token is unwrapped once. Never written unencrypted."
                    >
                      <Input
                        type="password"
                        value={f['token'] ?? ''}
                        onChange={(e) => set('token', e.target.value)}
                        className={mono}
                        autoComplete="off"
                      />
                    </Field>
                  ) : (
                    <div className="grid gap-3 @lg:grid-cols-2">
                      <Field label="Role ID">
                        <Input
                          value={f['roleId'] ?? ''}
                          onChange={(e) => set('roleId', e.target.value)}
                          className={mono}
                          spellCheck={false}
                          autoComplete="off"
                        />
                      </Field>
                      <Field
                        label="Secret ID"
                        hint="Used once to log in, then discarded. AppRole is designed for machines: each login consumes a secret_id use, and CIDR-bound roles fail from a laptop that changes networks."
                      >
                        <Input
                          type="password"
                          value={f['secretId'] ?? ''}
                          onChange={(e) => set('secretId', e.target.value)}
                          className={mono}
                          autoComplete="off"
                        />
                      </Field>
                    </div>
                  )}
                  {caField}
                  <label className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      className="accent-(--lemon-ink)"
                      checked={f['keep'] === '1'}
                      onChange={(e) => set('keep', e.target.checked ? '1' : '')}
                    />
                    Save the token in the OS keyring (unticked: kept for this session only)
                  </label>
                  <p className="text-[11px] text-muted-foreground">
                    Connect checks health, your token, the KV v2 mount and your permissions before
                    anything is saved. Reads render redacted shapes; every write is a reviewed,
                    check-and-set-guarded new version.
                  </p>
                </>
              )}
              {kind === 'github' && (
                <>
                  <div className="grid gap-3 @lg:grid-cols-2">
                    <Field label="Owner" hint="User or organization login.">
                      <Input
                        value={f['owner'] ?? ''}
                        onChange={(e) => set('owner', e.target.value)}
                        placeholder="acme"
                        className={mono}
                        spellCheck={false}
                        autoComplete="off"
                        autoFocus
                      />
                    </Field>
                    <Field
                      label="Repository (optional)"
                      hint="Empty: the organization's secrets and variables instead."
                    >
                      <Input
                        value={f['repo'] ?? ''}
                        onChange={(e) => set('repo', e.target.value)}
                        placeholder="api"
                        className={mono}
                        spellCheck={false}
                        autoComplete="off"
                      />
                    </Field>
                  </div>
                  {tokenField(
                    'Token',
                    'Fine-grained PAT with Actions secrets and variables read (Environments read for environment scopes), or a classic token with repo / admin:org.'
                  )}
                  <p className="text-[11px] text-muted-foreground">
                    Files: <code className="font-mono">.env</code> for the repository (or
                    organization) plus <code className="font-mono">.env.&lt;environment&gt;</code>{' '}
                    per deployment environment. Variables carry values. Secrets are names only,
                    GitHub never returns them: drift is present / missing, never changed.
                  </p>
                  {readOnlyNote}
                </>
              )}
              {kind === 'vercel' && (
                <>
                  <div className="grid gap-3 @lg:grid-cols-2">
                    <Field label="Project" hint="Name or id (prj_…).">
                      <Input
                        value={f['project'] ?? ''}
                        onChange={(e) => set('project', e.target.value)}
                        placeholder="web"
                        className={mono}
                        spellCheck={false}
                        autoComplete="off"
                        autoFocus
                      />
                    </Field>
                    <Field label="Team id (optional)" hint="team_… for team-owned projects.">
                      <Input
                        value={f['teamId'] ?? ''}
                        onChange={(e) => set('teamId', e.target.value)}
                        className={mono}
                        spellCheck={false}
                        autoComplete="off"
                      />
                    </Field>
                  </div>
                  {tokenField(
                    'Token',
                    'Account → Settings → Tokens. Read access to the project is enough.'
                  )}
                  <p className="text-[11px] text-muted-foreground">
                    One file per target (production, preview, development) plus{' '}
                    <code className="font-mono">branches/&lt;branch&gt;/.env.preview</code> for
                    branch-scoped variables. Sensitive variables are names only.
                  </p>
                  {readOnlyNote}
                </>
              )}
              {kind === 'railway' && (
                <>
                  <Field
                    label="Project"
                    hint="Name, or the project id from its settings (team projects)."
                  >
                    <Input
                      value={f['project'] ?? ''}
                      onChange={(e) => set('project', e.target.value)}
                      placeholder="shop"
                      className={mono}
                      spellCheck={false}
                      autoComplete="off"
                      autoFocus
                    />
                  </Field>
                  {tokenField(
                    'Token',
                    'Account or team token (Account settings → Tokens). Project tokens are not supported.'
                  )}
                  <p className="text-[11px] text-muted-foreground">
                    Files per environment: shared variables and one per service.
                  </p>
                  {readOnlyNote}
                </>
              )}
              {kind === 'render' && (
                <>
                  {tokenField(
                    'API key',
                    'Account settings → API keys. Everything the key can see is listed.'
                  )}
                  <p className="text-[11px] text-muted-foreground">
                    Files: <code className="font-mono">env-groups/&lt;name&gt;/.env</code> and{' '}
                    <code className="font-mono">services/&lt;name&gt;/.env</code>. Secret files in a
                    group are noted, not read.
                  </p>
                  {readOnlyNote}
                </>
              )}
              {kind === 'dokploy' && (
                <>
                  {addressField('https://dokploy.example.com')}
                  {tokenField('API key', 'Settings → API/CLI → generate.')}
                  {caField}
                  <p className="text-[11px] text-muted-foreground">
                    One file per application, named by project and application. The env text is read
                    as stored.
                  </p>
                  {readOnlyNote}
                </>
              )}
              {kind === 'coolify' && (
                <>
                  {addressField('https://coolify.example.com')}
                  {tokenField(
                    'API token',
                    'Keys & Tokens → API tokens, read-only scope is enough.'
                  )}
                  {caField}
                  <p className="text-[11px] text-muted-foreground">
                    One file per application, plus <code className="font-mono">.env.preview</code>{' '}
                    for preview-deployment variables.
                  </p>
                  {readOnlyNote}
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
              <Button type="submit" className="press" disabled={!ready || busy}>
                {busy ? (
                  <Loader2 className="animate-spin motion-reduce:animate-none" />
                ) : (
                  <SourceIcon kind={src.kind} />
                )}
                {mode === 'edit'
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
