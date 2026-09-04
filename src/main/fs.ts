import { readFile, writeFile, rename, stat, unlink, readdir } from 'node:fs/promises'
import { dirname, join, relative, resolve, posix } from 'node:path'
import { randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { homedir, tmpdir } from 'node:os'
import { mkdirSync } from 'node:fs'
import { ENV_FILE, SKIP_DIRS } from '@shared/env-file'
import { PROVIDERS, type EnvFileInfo, type ProviderId, type ScanResult } from '@shared/channels'

/**
 * Every file operation in main goes through here, keyed by a *ref*:
 *   - a plain absolute path → this machine
 *   - `ssh://<host>/<path>` → a remote machine via the user's own `ssh` (config,
 *     keys, agent and known_hosts all apply; nothing is stored by Drift)
 *   - `docker://[<host>]/<container>/<path>` → a running container via the user's
 *     own `docker` CLI (`docker exec`), locally or on an ssh daemon host
 *   - `vault://<conn>/<mount>/<path>` → HashiCorp Vault KV v2 (src/main/providers/vault)
 *   - `<provider>://<conn>/<path>` → a read-only API provider (src/main/providers/<id>)
 * Remote shell targets are assumed to be Linux with GNU coreutils.
 */
export type Ref =
  | { kind: 'local'; path: string }
  | { kind: 'ssh'; host: string; path: string }
  | { kind: 'docker'; host: string | null; container: string; path: string }
  | { kind: 'vault'; connectionId: number; mount: string; path: string }
  | { kind: 'provider'; provider: ProviderId; connectionId: number; path: string }

const SSH = /^ssh:\/\/([A-Za-z0-9._@-]+)(\/.*)$/
const DOCKER = /^docker:\/\/([A-Za-z0-9._@-]*)\/([A-Za-z0-9][A-Za-z0-9_.-]*)(\/.*)$/
const VAULT = /^vault:\/\/(\d+)\/([^/]+)\/(.+?)\/*$/
const PROVIDER = /^([a-z][a-z0-9-]*):\/\/(\d+)(?:\/(.*))?$/
const isProviderId = (s: string): s is ProviderId => (PROVIDERS as readonly string[]).includes(s)

export function parseRef(ref: string): Ref {
  const v = VAULT.exec(ref)
  if (v)
    return {
      kind: 'vault',
      connectionId: Number(v[1]),
      mount: decodeURIComponent(v[2]),
      path: v[3]
    }
  const d = DOCKER.exec(ref)
  if (d) return { kind: 'docker', host: d[1] || null, container: d[2], path: d[3] }
  const m = SSH.exec(ref)
  if (m) return { kind: 'ssh', host: m[1], path: m[2] }
  const p = PROVIDER.exec(ref)
  if (p && isProviderId(p[1]))
    return {
      kind: 'provider',
      provider: p[1],
      connectionId: Number(p[2]),
      path: (p[3] ?? '').replace(/\/+$/, '')
    }
  return { kind: 'local', path: ref }
}
export const isRemote = (ref: string): boolean => parseRef(ref).kind !== 'local'
/** Provider refs have no write path at all (see writeAtomic). */
export const isReadOnlyRef = (ref: string): boolean => parseRef(ref).kind === 'provider'
export const sshRef = (host: string, path: string): string => `ssh://${host}${path}`
export const dockerRef = (host: string | null, container: string, path: string): string =>
  `docker://${host ?? ''}/${container}${path}`
export const vaultRef = (connectionId: number, mount: string, path: string): string =>
  `vault://${connectionId}/${encodeURIComponent(mount)}/${path.replace(/^\/+|\/+$/g, '')}`
export const providerRef = (provider: ProviderId, connectionId: number, path: string): string =>
  `${provider}://${connectionId}${path ? '/' + path.replace(/^\/+|\/+$/g, '') : ''}`
/** Join a relative path onto a ref of any kind. */
export function joinRef(root: string, rel: string): string {
  const r = parseRef(root)
  switch (r.kind) {
    case 'vault':
      return vaultRef(r.connectionId, r.mount, posix.join(r.path, rel))
    case 'ssh':
      return sshRef(r.host, posix.join(r.path, rel))
    case 'docker':
      return dockerRef(r.host, r.container, posix.join(r.path, rel))
    case 'provider':
      return providerRef(r.provider, r.connectionId, posix.join(r.path, rel))
    default:
      return join(r.path, rel)
  }
}
export function relRef(root: string, ref: string): string {
  const a = parseRef(root)
  const b = parseRef(ref)
  return a.kind === 'local' ? relative(a.path, b.path) : posix.relative(a.path, b.path)
}

// ---------- backend seams (vault, providers) ----------

export type VaultRef = Extract<Ref, { kind: 'vault' }>
export type ProviderRef = Extract<Ref, { kind: 'provider' }>
/**
 * Adapters register themselves here (src/main/providers/*). The MCP process
 * never registers one, so these refs fail there with a clear message instead of
 * ever seeing a credential.
 */
export type VaultBackend = {
  readText(ref: VaultRef): Promise<string>
  stat(ref: VaultRef): Promise<Stat>
  scan(root: string, ref: VaultRef): Promise<ScanResult>
}
/**
 * A read with its metadata. `opaque` names keys the provider reports by name
 * only (GitHub secrets, Vercel sensitive vars, ECS secrets): the text carries a
 * placeholder for them, and only this set (never the text) marks them opaque.
 */
export type EnvRead = { text: string; opaque: ReadonlySet<string> }
export type ProviderBackend = {
  readText(ref: ProviderRef): Promise<string>
  /** Text plus opacity metadata. Backends without names-only keys may omit it. */
  readEnv?(ref: ProviderRef): Promise<EnvRead>
  stat(ref: ProviderRef): Promise<Stat>
  scan(root: string, ref: ProviderRef): Promise<ScanResult>
}
let vaultBackend: VaultBackend | null = null
const backends = new Map<ProviderId, ProviderBackend>()
export function registerVaultBackend(b: VaultBackend): void {
  vaultBackend = b
}
export function registerProviderBackend(id: ProviderId, b: ProviderBackend): void {
  backends.set(id, b)
}
function vb(): VaultBackend {
  if (!vaultBackend) throw new Error('Vault sources are only available inside the Drift app.')
  return vaultBackend
}
function pb(r: ProviderRef): ProviderBackend {
  const b = backends.get(r.provider)
  if (!b) throw new Error(`${r.provider} sources are only available inside the Drift app.`)
  return b
}
export function baseRef(ref: string): string {
  return posix.basename(parseRef(ref).path.replace(/\\/g, '/'))
}

// ---------- shell transports: ssh and docker exec ----------

const run = promisify(execFile)

let controlDirReady: string | null = null
/** ~/.ssh/drift, created once, mode 700. Falls back to no multiplexing if that fails. */
function controlDir(): string {
  if (controlDirReady) return controlDirReady
  const dir = join(homedir(), '.ssh', 'drift')
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    controlDirReady = dir
  } catch {
    controlDirReady = tmpdir()
  }
  return controlDirReady
}
const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

/** Run a shell script on `host` via the system ssh. Non-interactive: keys or agent only. */
export async function sshExec(host: string, script: string, timeoutMs = 60_000): Promise<string> {
  // Unix sockets cap at ~104 bytes; macOS temp dirs alone are ~50. A short path under
  // ~/.ssh with the short %C hash keeps multiplexing working everywhere.
  const control =
    process.platform === 'win32'
      ? []
      : [
          '-o',
          'ControlMaster=auto',
          '-o',
          `ControlPath=${controlDir()}/d-%C`,
          '-o',
          'ControlPersist=120'
        ]
  try {
    const { stdout } = await run(
      'ssh',
      ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', ...control, host, 'sh', '-c', q(script)],
      { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }
    )
    return stdout
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: string; code?: number | string }
    if (err.code === 'ENOENT') throw new Error('ssh is not installed on this machine')
    const lines = (err.stderr ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !/^Warning: Permanently added/.test(l))
    const msg = lines[lines.length - 1] ?? ''
    // The exact command, so the user can reproduce it in a terminal and see the same output.
    const repro = `ssh -o BatchMode=yes ${host} true`
    let hint = ''
    if (/Permission denied|publickey/i.test(msg))
      hint =
        'Drift runs ssh non-interactively (BatchMode): the key must be loaded in your agent or have no passphrase, and Tailscale SSH must not need a browser check.'
    else if (/Host key verification failed/i.test(msg))
      hint = 'Connect once from a terminal so the host key lands in known_hosts.'
    throw new Error(`${host}: ${msg || 'ssh failed'}.${hint ? ' ' + hint : ''} Try: ${repro}`)
  }
}

/** Argument array for `docker [-H ssh://host] exec <container> sh -c <script>`. Never a shell string. */
export function dockerArgs(host: string | null, container: string, script: string): string[] {
  return [...(host ? ['-H', `ssh://${host}`] : []), 'exec', container, 'sh', '-c', script]
}

/**
 * Run a shell script inside a running container via the user's own `docker` CLI.
 * A remote daemon is reached with `-H ssh://host`, so the same ssh config, keys
 * and agent apply as for SSH sources. The container needs `sh` and coreutils.
 */
export async function dockerExec(
  host: string | null,
  container: string,
  script: string,
  timeoutMs = 60_000
): Promise<string> {
  try {
    const { stdout } = await run('docker', dockerArgs(host, container, script), {
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, DOCKER_CLI_HINTS: 'false' }
    })
    return stdout
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: string; code?: number | string }
    if (err.code === 'ENOENT') throw new Error('docker is not installed on this machine')
    const msg =
      (err.stderr ?? '')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .pop() ?? ''
    const where = host ? `${container} on ${host}` : container
    let hint = ''
    if (/No such container/i.test(msg)) hint = 'Check the name with `docker ps`.'
    else if (/is not running/i.test(msg))
      hint = 'Start it first; Drift only reads running containers.'
    else if (
      /Cannot connect to the Docker daemon|permission denied while trying to connect/i.test(msg)
    )
      hint = 'Is the daemon running, and is your user allowed to use it?'
    else if (/executable file not found|exec: "sh"/i.test(msg))
      hint = 'The container has no `sh` (distroless image); Drift cannot read it.'
    throw new Error(`docker ${where}: ${msg || 'docker exec failed'}.${hint ? ' ' + hint : ''}`)
  }
}

type ShellTarget =
  | { kind: 'ssh'; host: string; path: string }
  | { kind: 'docker'; host: string | null; container: string; path: string }
const shell = (t: ShellTarget, script: string, timeoutMs?: number): Promise<string> =>
  t.kind === 'ssh'
    ? sshExec(t.host, script, timeoutMs)
    : dockerExec(t.host, t.container, script, timeoutMs)
const shellRef = (t: ShellTarget, path: string): string =>
  t.kind === 'ssh' ? sshRef(t.host, path) : dockerRef(t.host, t.container, path)

/** Host aliases declared in ~/.ssh/config (no wildcards). Read-only, names only. */
export async function sshConfigHosts(): Promise<string[]> {
  try {
    const text = await readFile(join(homedir(), '.ssh', 'config'), 'utf8')
    const out = new Set<string>()
    for (const line of text.split('\n')) {
      const m = /^\s*Host\s+(.+)$/i.exec(line)
      if (!m) continue
      for (const h of m[1].trim().split(/\s+/)) if (!/[*?!]/.test(h)) out.add(h)
    }
    return [...out].sort()
  } catch {
    return []
  }
}

/** Running containers on a daemon (names only), for the source dialog. */
export async function dockerContainers(host: string | null): Promise<string[]> {
  try {
    const { stdout } = await run(
      'docker',
      [...(host ? ['-H', `ssh://${host}`] : []), 'ps', '--format', '{{.Names}}'],
      { timeout: 20_000, env: { ...process.env, DOCKER_CLI_HINTS: 'false' } }
    )
    return stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .sort()
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: string }
    if (err.code === 'ENOENT') throw new Error('docker is not installed on this machine')
    throw new Error(
      `docker ps failed: ${(err.stderr ?? '').trim().split('\n').pop() || err.message}`
    )
  }
}

// ---------- primitives ----------

export type Stat = { mtimeMs: number; size: number; mode?: number }

export async function readText(ref: string): Promise<string> {
  const r = parseRef(ref)
  if (r.kind === 'local') return readFile(r.path, 'utf8')
  if (r.kind === 'vault') return vb().readText(r)
  if (r.kind === 'provider') return pb(r).readText(r)
  return shell(r, `cat ${q(r.path)}`)
}

const NO_OPAQUE: ReadonlySet<string> = new Set()
/** readText plus opacity metadata. Files, SSH, Docker and Vault never have opaque keys. */
export async function readEnv(ref: string): Promise<EnvRead> {
  const r = parseRef(ref)
  if (r.kind === 'provider') {
    const b = pb(r)
    if (b.readEnv) return b.readEnv(r)
  }
  return { text: await readText(ref), opaque: NO_OPAQUE }
}

export async function statRef(ref: string): Promise<Stat> {
  const r = parseRef(ref)
  if (r.kind === 'vault') return vb().stat(r)
  if (r.kind === 'provider') return pb(r).stat(r)
  if (r.kind === 'local') {
    const s = await stat(r.path)
    return { mtimeMs: s.mtimeMs, size: s.size, mode: s.mode }
  }
  // %y carries nanoseconds ("2026-08-23 10:00:00.123456789 +0000"); %Y alone is whole seconds,
  // too coarse for the write guard.
  const out = (await shell(r, `stat -c '%Y %s %y' ${q(r.path)}`)).trim()
  const m = /^(\d+) (\d+) \S+ \d\d:\d\d:\d\d(?:\.(\d+))?/.exec(out)
  if (!m) throw new Error(`${ref}: not found`)
  const frac = m[3] ? Number(`0.${m[3]}`) : 0
  return { mtimeMs: Number(m[1]) * 1000 + frac * 1000, size: Number(m[2]) }
}

/** Temp file next to the target, then rename over it. Same guarantee locally and remotely. */
export async function writeAtomic(ref: string, text: string): Promise<void> {
  const r = parseRef(ref)
  if (r.kind === 'vault')
    throw new Error(
      'Vault environments are not written as files. Use Compare \u2192 Apply, or restore a version from its history.'
    )
  if (r.kind === 'provider')
    throw new Error(
      `${r.provider} sources are read-only in Drift: change values in ${r.provider} itself, then rescan.`
    )
  if (r.kind === 'local') {
    const tmp = join(dirname(r.path), `.${randomBytes(6).toString('hex')}.drift-tmp`)
    const mode = (await stat(r.path).catch(() => null))?.mode
    try {
      await writeFile(tmp, text, mode !== undefined ? { mode } : undefined)
      await rename(tmp, r.path)
    } catch (e) {
      await unlink(tmp).catch(() => {})
      throw e
    }
    return
  }
  const tmp = posix.join(posix.dirname(r.path), `.${randomBytes(6).toString('hex')}.drift-tmp`)
  const b64 = Buffer.from(text, 'utf8').toString('base64')
  // Keep the target's mode when it exists; base64 keeps the content opaque to the shell.
  await shell(
    r,
    `set -e; printf %s ${q(b64)} | base64 -d > ${q(tmp)}; ` +
      `if [ -e ${q(r.path)} ]; then chmod --reference=${q(r.path)} ${q(tmp)} 2>/dev/null || true; fi; ` +
      `mv -f ${q(tmp)} ${q(r.path)}`
  )
}

/** Verify a remote root exists and is a directory. Throws a readable error otherwise. */
export async function checkRemoteRoot(host: string, path: string): Promise<void> {
  const out = (await sshExec(host, `test -d ${q(path)} && echo ok || echo missing`)).trim()
  if (out !== 'ok') throw new Error(`${host}: ${path} is not a directory`)
}
export async function checkDockerRoot(
  host: string | null,
  container: string,
  path: string
): Promise<void> {
  const out = (
    await dockerExec(host, container, `test -d ${q(path)} && echo ok || echo missing`)
  ).trim()
  if (out !== 'ok') throw new Error(`${container}: ${path} is not a directory in the container`)
}

// ---------- scan ----------

async function scanLocal(root: string): Promise<ScanResult> {
  const started = performance.now()
  const files: EnvFileInfo[] = []
  let scannedDirs = 0
  async function walk(dir: string, project: string | null): Promise<void> {
    scannedDirs += 1
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    const isRepo = entries.some((e) => e.name === '.git')
    const here = isRepo ? relative(root, dir) || '.' : project
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue
        await walk(full, here)
      } else if (e.isFile() && ENV_FILE.test(e.name)) {
        try {
          const s = await stat(full)
          files.push({
            path: full,
            root,
            rel: relative(root, full),
            name: e.name,
            project: here,
            modifiedAt: s.mtimeMs,
            size: s.size
          })
        } catch {
          /* vanished between readdir and stat */
        }
      }
    }
  }
  await walk(resolve(root), null)
  return finish(root, files, scannedDirs, started)
}

/** One script lists env files, .git markers and the directory count for any shell target. */
export function scanScript(path: string): string {
  const prune = [...SKIP_DIRS].map((d) => `-name ${q(d)}`).join(' -o ')
  // .git must not be pruned before it is printed in the repo listing.
  const pruneNoGit = [...SKIP_DIRS]
    .filter((d) => d !== '.git')
    .map((d) => `-name ${q(d)}`)
    .join(' -o ')
  // One round trip: env files with mtime/size, a separator, then every .git (dir, or file for worktrees).
  return (
    `cd ${q(path)} || exit 2; ` +
    `find . \\( ${prune} \\) -prune -o -type f -name '.env*' -print0 | xargs -0 -r stat -c '%Y %s %y %n'; ` +
    `echo __DRIFT_GIT__; ` +
    `find . \\( ${pruneNoGit} \\) -prune -o -name .git -print -prune; ` +
    `echo __DRIFT_DIRS__; ` +
    `find . \\( ${prune} \\) -prune -o -type d -print | wc -l`
  )
}

/** Turn scanScript output into files. Exported so exec-based backends (ECS) reuse it. */
export function parseScanOutput(
  root: string,
  out: string,
  toRef: (path: string) => string,
  base: string
): { files: EnvFileInfo[]; dirs: number } {
  const [filesPart, gitPart = '', dirsPart = '0'] = out.split(/__DRIFT_(?:GIT|DIRS)__\n?/)
  const gitDirs = gitPart
    .split('\n')
    .filter(Boolean)
    .map((g) =>
      g
        .replace(/^\.\//, '')
        .replace(/\/\.git$/, '')
        .replace(/^\.git$/, '.')
    )
    .sort((a, b) => b.length - a.length)
  const files: EnvFileInfo[] = []
  for (const line of filesPart.split('\n')) {
    // Same shape and precision as statRef, so the write guard compares like with like.
    const m = /^(\d+) (\d+) \S+ \d\d:\d\d:\d\d(?:\.(\d+))? \S+ \.\/(.+)$/.exec(line)
    if (!m) continue
    const rel = m[4]
    const name = posix.basename(rel)
    if (!ENV_FILE.test(name)) continue
    const project = gitDirs.find((g) => g === '.' || rel === g || rel.startsWith(g + '/')) ?? null
    files.push({
      path: toRef(posix.join(base, rel)),
      root,
      rel,
      name,
      project,
      modifiedAt: Number(m[1]) * 1000 + (m[3] ? Number(`0.${m[3]}`) * 1000 : 0),
      size: Number(m[2])
    })
  }
  return { files, dirs: Number(dirsPart.trim()) || 0 }
}

async function scanShell(root: string, t: ShellTarget): Promise<ScanResult> {
  const started = performance.now()
  const out = await shell(t, scanScript(t.path), 120_000)
  const { files, dirs } = parseScanOutput(root, out, (p) => shellRef(t, p), t.path)
  return finish(root, files, dirs, started)
}

export function finish(
  root: string,
  files: EnvFileInfo[],
  scannedDirs: number,
  started: number
): ScanResult {
  files.sort((a, b) => a.rel.localeCompare(b.rel))
  const projects = [
    ...new Set(files.map((f) => f.project).filter((p): p is string => p !== null))
  ].sort()
  return { root, files, projects, scannedDirs, durationMs: Math.round(performance.now() - started) }
}

export function scanRoot(root: string): Promise<ScanResult> {
  const r = parseRef(root)
  if (r.kind === 'vault') return vb().scan(root, r)
  if (r.kind === 'provider') return pb(r).scan(root, r)
  return r.kind === 'local' ? scanLocal(r.path) : scanShell(root, r)
}
