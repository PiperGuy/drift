import { readFile, writeFile, rename, stat, unlink, readdir } from 'node:fs/promises'
import { dirname, join, relative, resolve, posix } from 'node:path'
import { randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { homedir, tmpdir } from 'node:os'
import { mkdirSync } from 'node:fs'
import { ENV_FILE, SKIP_DIRS } from '@shared/env-file'
import type { EnvFileInfo, ScanResult } from '@shared/channels'

/**
 * Every file operation in main goes through here, keyed by a *ref*:
 *   - a plain absolute path → this machine
 *   - `ssh://<host>/<path>` → a remote machine via the user's own `ssh` (config,
 *     keys, agent and known_hosts all apply; nothing is stored by Drift)
 * Docker / ECS backends would be two more `parseRef` kinds with the same shape.
 * Remote targets are assumed to be Linux with GNU coreutils (a VPS).
 */
export type Ref = { kind: 'local'; path: string } | { kind: 'ssh'; host: string; path: string }

const SSH = /^ssh:\/\/([A-Za-z0-9._@-]+)(\/.*)$/

export function parseRef(ref: string): Ref {
  const m = SSH.exec(ref)
  return m ? { kind: 'ssh', host: m[1], path: m[2] } : { kind: 'local', path: ref }
}
export const isRemote = (ref: string): boolean => SSH.test(ref)
export const sshRef = (host: string, path: string): string => `ssh://${host}${path}`
/** Join a relative path onto a ref of either kind. */
export function joinRef(root: string, rel: string): string {
  const r = parseRef(root)
  return r.kind === 'ssh' ? sshRef(r.host, posix.join(r.path, rel)) : join(r.path, rel)
}
export function relRef(root: string, ref: string): string {
  const a = parseRef(root)
  const b = parseRef(ref)
  return a.kind === 'ssh' ? posix.relative(a.path, b.path) : relative(a.path, b.path)
}
export function baseRef(ref: string): string {
  return posix.basename(parseRef(ref).path.replace(/\\/g, '/'))
}

// ---------- ssh transport ----------

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
    const msg = (err.stderr ?? '').trim().split('\n').pop() ?? ''
    if (/Permission denied|publickey/i.test(msg))
      throw new Error(
        `${host}: authentication failed. Drift uses your ssh keys or agent; BatchMode, so no password prompts.`
      )
    if (/Host key verification failed/i.test(msg))
      throw new Error(
        `${host}: host key not trusted. Connect once from a terminal so it lands in known_hosts.`
      )
    throw new Error(`${host}: ${msg || 'ssh failed'}`)
  }
}

// ---------- primitives ----------

export type Stat = { mtimeMs: number; size: number; mode?: number }

export async function readText(ref: string): Promise<string> {
  const r = parseRef(ref)
  if (r.kind === 'local') return readFile(r.path, 'utf8')
  return sshExec(r.host, `cat ${q(r.path)}`)
}

export async function statRef(ref: string): Promise<Stat> {
  const r = parseRef(ref)
  if (r.kind === 'local') {
    const s = await stat(r.path)
    return { mtimeMs: s.mtimeMs, size: s.size, mode: s.mode }
  }
  // %y carries nanoseconds ("2026-08-23 10:00:00.123456789 +0000"); %Y alone is whole seconds,
  // too coarse for the write guard.
  const out = (await sshExec(r.host, `stat -c '%Y %s %y' ${q(r.path)}`)).trim()
  const m = /^(\d+) (\d+) \S+ \d\d:\d\d:\d\d(?:\.(\d+))?/.exec(out)
  if (!m) throw new Error(`${ref}: not found`)
  const frac = m[3] ? Number(`0.${m[3]}`) : 0
  return { mtimeMs: Number(m[1]) * 1000 + frac * 1000, size: Number(m[2]) }
}

/** Temp file next to the target, then rename over it. Same guarantee locally and remotely. */
export async function writeAtomic(ref: string, text: string): Promise<void> {
  const r = parseRef(ref)
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
  await sshExec(
    r.host,
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

async function scanSsh(root: string, host: string, path: string): Promise<ScanResult> {
  const started = performance.now()
  const prune = [...SKIP_DIRS].map((d) => `-name ${q(d)}`).join(' -o ')
  // .git must not be pruned before it is printed in the repo listing.
  const pruneNoGit = [...SKIP_DIRS]
    .filter((d) => d !== '.git')
    .map((d) => `-name ${q(d)}`)
    .join(' -o ')
  // One round trip: env files with mtime/size, a separator, then every .git (dir, or file for worktrees).
  const script =
    `cd ${q(path)} || exit 2; ` +
    `find . \\( ${prune} \\) -prune -o -type f -name '.env*' -print0 | xargs -0 -r stat -c '%Y %s %y %n'; ` +
    `echo __DRIFT_GIT__; ` +
    `find . \\( ${pruneNoGit} \\) -prune -o -name .git -print -prune; ` +
    `echo __DRIFT_DIRS__; ` +
    `find . \\( ${prune} \\) -prune -o -type d -print | wc -l`
  const out = await sshExec(host, script, 120_000)
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
      path: sshRef(host, posix.join(path, rel)),
      root,
      rel,
      name,
      project,
      modifiedAt: Number(m[1]) * 1000 + (m[3] ? Number(`0.${m[3]}`) * 1000 : 0),
      size: Number(m[2])
    })
  }
  return finish(root, files, Number(dirsPart.trim()) || 0, started)
}

function finish(
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
  return r.kind === 'ssh' ? scanSsh(root, r.host, r.path) : scanLocal(r.path)
}
