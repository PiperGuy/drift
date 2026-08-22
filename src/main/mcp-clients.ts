import { readFile, writeFile, mkdir, cp, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import type { McpClientId, McpClientStatus, McpLaunch } from '@shared/channels'

/**
 * One-click MCP setup for coding agents. Each client owns a config file; we add or
 * remove one `drift` entry and touch nothing else in it. This is the only place
 * the app writes outside its own data directory, and only on an explicit click.
 */
type Client = {
  id: McpClientId
  label: string
  /** Config file per platform. */
  file: (p: NodeJS.Platform, home: string) => string
  /** JSON key holding servers, or 'toml' for Codex. */
  format: 'mcpServers' | 'servers' | 'toml'
  /** Where a Claude Code skill can be installed alongside the server. */
  skills?: (home: string) => string
}

const appData = (p: NodeJS.Platform, home: string): string =>
  p === 'darwin'
    ? join(home, 'Library', 'Application Support')
    : p === 'win32'
      ? (process.env['APPDATA'] ?? join(home, 'AppData', 'Roaming'))
      : (process.env['XDG_CONFIG_HOME'] ?? join(home, '.config'))

export const CLIENTS: Client[] = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    file: (_p, h) => join(h, '.claude.json'),
    format: 'mcpServers',
    skills: (h) => join(h, '.claude', 'skills')
  },
  {
    id: 'claude-desktop',
    label: 'Claude Desktop',
    file: (p, h) => join(appData(p, h), 'Claude', 'claude_desktop_config.json'),
    format: 'mcpServers'
  },
  {
    id: 'codex',
    label: 'Codex',
    file: (_p, h) => join(h, '.codex', 'config.toml'),
    format: 'toml'
  },
  {
    id: 'cursor',
    label: 'Cursor',
    file: (_p, h) => join(h, '.cursor', 'mcp.json'),
    format: 'mcpServers'
  },
  {
    id: 'copilot',
    label: 'GitHub Copilot (VS Code)',
    file: (p, h) => join(appData(p, h), 'Code', 'User', 'mcp.json'),
    format: 'servers'
  },
  {
    id: 'windsurf',
    label: 'Windsurf',
    file: (_p, h) => join(h, '.codeium', 'windsurf', 'mcp_config.json'),
    format: 'mcpServers'
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    file: (_p, h) => join(h, '.gemini', 'settings.json'),
    format: 'mcpServers'
  }
]

const NAME = 'drift'

async function readJson(file: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new Error(`${file} is not valid JSON; fix it by hand first`)
  }
}

const tomlHeader = `[mcp_servers.${NAME}]`
/** Our header line, allowing whitespace and a trailing comment. */
const isHeader = (line: string): boolean =>
  new RegExp(`^\\s*\\[mcp_servers\\.${NAME}\\]\\s*(#.*)?$`).test(line)
/** Remove our table: from our header line up to the next line that starts a table, or EOF. */
function stripToml(text: string): string {
  const lines = text.split('\n')
  const out: string[] = []
  let skipping = false
  for (const line of lines) {
    if (isHeader(line)) {
      skipping = true
      continue
    }
    if (skipping && /^\s*\[/.test(line)) skipping = false
    if (!skipping) out.push(line)
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n')
}

function tomlEntry(l: McpLaunch): string {
  const s = (v: string): string => JSON.stringify(v)
  const env = Object.entries(l.env)
    .map(([k, v]) => `${s(k)} = ${s(v)}`)
    .join(', ')
  return `\n${tomlHeader}\ncommand = ${s(l.command)}\nargs = [${l.args.map(s).join(', ')}]\nenv = { ${env} }\n`
}

export async function statusAll(
  platform = process.platform,
  home = homedir()
): Promise<McpClientStatus[]> {
  return Promise.all(
    CLIENTS.map(async (c) => {
      const file = c.file(platform, home)
      let installed = false
      try {
        const text = await readFile(file, 'utf8')
        installed =
          c.format === 'toml'
            ? text.split('\n').some(isHeader)
            : Boolean((JSON.parse(text)[c.format] as Record<string, unknown> | undefined)?.[NAME])
      } catch {
        /* missing or unreadable: not installed */
      }
      return { id: c.id, label: c.label, file, installed, skill: Boolean(c.skills) }
    })
  )
}

export async function install(
  id: McpClientId,
  launch: McpLaunch,
  skillDir: string | null,
  platform = process.platform,
  home = homedir()
): Promise<void> {
  const c = CLIENTS.find((x) => x.id === id)
  if (!c) throw new Error(`Unknown client ${id}`)
  const file = c.file(platform, home)
  await mkdir(dirname(file), { recursive: true })
  if (c.format === 'toml') {
    let text = ''
    try {
      text = await readFile(file, 'utf8')
    } catch {
      /* new file */
    }
    await writeFile(file, stripToml(text) + tomlEntry(launch))
  } else {
    const cfg = await readJson(file)
    const servers = (cfg[c.format] ??= {}) as Record<string, unknown>
    servers[NAME] =
      c.format === 'servers'
        ? { type: 'stdio', command: launch.command, args: launch.args, env: launch.env }
        : { command: launch.command, args: launch.args, env: launch.env }
    await writeFile(file, JSON.stringify(cfg, null, 2) + '\n')
  }
  if (c.skills && skillDir) {
    await cp(skillDir, join(c.skills(home), NAME), { recursive: true })
  }
}

export async function uninstall(
  id: McpClientId,
  platform = process.platform,
  home = homedir()
): Promise<void> {
  const c = CLIENTS.find((x) => x.id === id)
  if (!c) throw new Error(`Unknown client ${id}`)
  const file = c.file(platform, home)
  try {
    if (c.format === 'toml') {
      const text = await readFile(file, 'utf8')
      await writeFile(file, stripToml(text))
    } else {
      const cfg = await readJson(file)
      const servers = cfg[c.format] as Record<string, unknown> | undefined
      if (servers) delete servers[NAME]
      await writeFile(file, JSON.stringify(cfg, null, 2) + '\n')
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  if (c.skills) await rm(join(c.skills(home), NAME), { recursive: true, force: true })
}
