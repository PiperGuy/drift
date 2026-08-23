/**
 * Channel names and the types that cross the bridge. This file must stay
 * free of runtime dependencies: the sandboxed preload imports it and cannot
 * require anything but `electron`. Validation schemas live in ./ipc.ts.
 * Values never cross the bridge: only key names, fingerprints and classes.
 */
import type { DriftReceipt, KeyEntry } from './drift'
import type { LicenseState } from './license'
import type { EnvView } from './env-lint'

export const Channels = {
  workspacePick: 'workspace:pick',
  workspaceScan: 'workspace:scan',
  envShape: 'env:shape',
  envCompare: 'env:compare',
  appInfo: 'app:info',
  workspaceRecent: 'workspace:recent',
  workspaceAddSsh: 'workspace:add-ssh',
  workspaceRemove: 'workspace:remove',
  wsList: 'ws:list',
  wsCreate: 'ws:create',
  wsRename: 'ws:rename',
  wsDelete: 'ws:delete',
  wsSwitch: 'ws:switch',
  historyList: 'history:list',
  dataForget: 'data:forget',
  dataClear: 'data:clear',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  licenseGet: 'license:get',
  licenseActivate: 'license:activate',
  updateCheck: 'update:check',
  mcpClients: 'mcp:clients',
  mcpInstall: 'mcp:install',
  mcpUninstall: 'mcp:uninstall',
  envReveal: 'env:reveal',
  updateEvent: 'update:event',
  updateInstall: 'update:install',
  trayCompare: 'tray:compare',
  envApply: 'env:apply',
  historySnapshots: 'history:snapshots',
  historyRollback: 'history:rollback',
  envView: 'env:view',
  envFormat: 'env:format',
  envSet: 'env:set',
  envRevealAll: 'env:reveal-all',
  windowFullscreen: 'window:fullscreen',
  sshHosts: 'ssh:hosts'
} as const

/** A source the user switches between: a named set of roots (usually one). `path` is its first root. */
export type Workspace = { id: number; name: string; roots: number; path: string | null }

/** A granted root: a local folder or ssh://host/path. */
export type RootInfo = { path: string; kind: 'local' | 'ssh'; label: string }

/** Discovered file. Metadata only. Contents are not opened during a scan. */
export type EnvFileInfo = {
  /** Local absolute path, or ssh://host/path. */
  path: string
  /** The granted root this file was found under. */
  root: string
  /** Path relative to the workspace root. */
  rel: string
  name: string
  /** Nearest ancestor that contains a .git directory, relative to root. null = ungrouped. */
  project: string | null
  modifiedAt: number
  size: number
}

export type ScanResult = {
  root: string
  files: EnvFileInfo[]
  projects: string[]
  scannedDirs: number
  durationMs: number
}

export type EnvShape = { path: string; name: string; entries: KeyEntry[] }

/** Append-only, redacted audit trail. Subject and detail hold paths, key names and counts. Never a value. */
export type HistoryKind =
  | 'grant'
  | 'revoke'
  | 'workspace'
  | 'scan'
  | 'compare'
  | 'forget'
  | 'clear'
  | 'license'
  | 'mcp_install'
  | 'mcp_uninstall'
  | 'reveal'
  | 'apply'
  | 'rollback'
  | 'format'
  | 'edit'
export type HistoryEvent = {
  id: number
  at: number
  kind: HistoryKind
  subject: Record<string, unknown>
  detail: Record<string, unknown>
}

export type AppInfo = {
  version: string
  platform: NodeJS.Platform
  electron: string
  node: string
  chrome: string
  /** Where the local store lives. */
  dataPath: string
  /** False when the OS keyring is unavailable: fingerprints are then per-session only. */
  keyPersisted: boolean
  /** How to launch the bundled MCP server: the app binary as Node, the server script, the store. */
  mcp: McpLaunch
}

export type McpLaunch = { command: string; args: string[]; env: Record<string, string> }
export type McpClientId =
  'claude-code' | 'claude-desktop' | 'codex' | 'cursor' | 'copilot' | 'windsurf' | 'gemini'
export type McpClientStatus = {
  id: McpClientId
  label: string
  file: string
  installed: boolean
  /** True when installing also drops the Drift skill next to the server config. */
  skill: boolean
}

/** User settings persisted in the store. */
export type Settings = { mcpEnabled: boolean; onboarded: boolean }

/** One approved write: copy these keys' assignments from left into right. */
export type ApplyRequest = {
  left: string
  right: string
  keys: string[]
  /** mtime the plan was made against; the write refuses if the file changed since. */
  expectedMtime: number
}
export type ApplyResult = {
  written: string[]
  skipped: { key: string; reason: string }[]
  snapshot: number
}

/** A file as it was just before Drift wrote to it (or restored it). Key names only in the clear. */
export type Snapshot = {
  id: number
  path: string
  at: number
  reason: 'apply' | 'rollback' | 'format' | 'edit'
  mtime: number
  size: number
  keys: string[]
  /** False when no keyring could seal the bytes: shape recorded, content not restorable. */
  restorable: boolean
}

export type ViewRequest = { path: string }
export type FormatRequest = { path: string; expectedMtime: number }
export type FormatResult = { changed: number; snapshot: number | null }

/** User-typed values for existing or new keys. The only renderer → main path carrying values. */
export type SetRequest = {
  path: string
  expectedMtime: number
  entries: { key: string; value: string }[]
}
export type SetResult = { written: string[]; snapshot: number }

export type RevealRequest = { path: string; key: string }
export type RevealResult = { value: string | null; method: 'touchid' | 'polkit' | 'dialog' }
/** Pushed from main while an update downloads in the background. */
export type UpdateEvent =
  | { kind: 'available'; version: string }
  | { kind: 'downloaded'; version: string }
  | { kind: 'error'; message: string }

export type UpdateResult =
  | { status: 'current'; version: string }
  | { status: 'available'; version: string }
  | { status: 'error'; message: string }

export type ScanRequest = { root: string }
export type ShapeRequest = { path: string }
export type CompareRequest = { left: string; right: string; ignore?: string[] }

/** What the preload exposes on `window.plumbr`. */
export type PlumbrApi = {
  pickWorkspace: () => Promise<RootInfo | null>
  scanWorkspace: (req: ScanRequest) => Promise<ScanResult>
  envShape: (req: ShapeRequest) => Promise<EnvShape>
  compareEnv: (req: CompareRequest) => Promise<DriftReceipt>
  appInfo: () => Promise<AppInfo>
  /** Every remembered root, re-granted for this session. Empty on first run. */
  recentWorkspaces: () => Promise<RootInfo[]>
  /** Verify over ssh, then grant and remember. `host` is anything ssh accepts: alias, user@host. */
  addSshRoot: (req: { host: string; path: string }) => Promise<RootInfo>
  removeRoot: (path: string) => Promise<void>
  listWorkspaces: () => Promise<{ active: number; all: Workspace[] }>
  createWorkspace: (name: string) => Promise<Workspace>
  renameWorkspace: (req: { id: number; name: string }) => Promise<void>
  deleteWorkspace: (id: number) => Promise<void>
  /** Make a workspace active: grants swap to its roots. Returns them. */
  switchWorkspace: (id: number) => Promise<RootInfo[]>
  listHistory: () => Promise<HistoryEvent[]>
  /** Wipe roots, receipts and history. Keeps the fingerprint key. */
  forgetData: () => Promise<void>
  /** Drop receipts and history, keep the workspace. */
  clearCache: () => Promise<void>
  getSettings: () => Promise<Settings>
  setSettings: (patch: Partial<Settings>) => Promise<Settings>
  getLicense: () => Promise<LicenseState>
  /** Verify and store a key. Resolves to the new state; rejects with a message on a bad key. */
  activateLicense: (key: string) => Promise<LicenseState>
  checkUpdates: () => Promise<UpdateResult>
  mcpClients: () => Promise<McpClientStatus[]>
  mcpInstall: (id: McpClientId) => Promise<McpClientStatus[]>
  mcpUninstall: (id: McpClientId) => Promise<McpClientStatus[]>
  /** One value, after OS auth. Rejects if cancelled. */
  revealValue: (req: RevealRequest) => Promise<RevealResult>
  /** Every value of one file, after OS auth. */
  revealAll: (
    req: ViewRequest
  ) => Promise<{ values: Record<string, string>; method: RevealResult['method'] }>
  onUpdate: (cb: (e: UpdateEvent) => void) => () => void
  installUpdate: () => Promise<void>
  /** Tray → "Compare again". */
  onTrayCompare: (cb: () => void) => () => void
  /** `Host` aliases from ~/.ssh/config, for the source dialog. Names only. */
  sshHosts: () => Promise<string[]>
  /** macOS full-screen transitions. */
  onFullscreen: (cb: (on: boolean) => void) => () => void
  /** The only write path. Main snapshots the target first. */
  applyPlan: (req: ApplyRequest) => Promise<ApplyResult>
  listSnapshots: () => Promise<Snapshot[]>
  /** Restore a snapshot over its file (snapshotting the current content first). */
  rollback: (id: number) => Promise<void>
  /** Redacted, typed rendering of a file with lint findings. */
  viewEnv: (req: ViewRequest) => Promise<EnvView>
  /** Rewrite in canonical form via the snapshot + atomic path. */
  formatEnv: (req: FormatRequest) => Promise<FormatResult>
  /** Update or add keys with typed values, via the snapshot + atomic path. */
  setValues: (req: SetRequest) => Promise<SetResult>
}
