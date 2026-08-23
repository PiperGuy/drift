/**
 * Channel names and the types that cross the bridge. This file must stay
 * free of runtime dependencies: the sandboxed preload imports it and cannot
 * require anything but `electron`. Validation schemas live in ./ipc.ts.
 * Values never cross the bridge: only key names, fingerprints and classes.
 */
import type { DriftReceipt, KeyEntry } from './drift'
import type { LicenseState } from './license'

export const Channels = {
  workspacePick: 'workspace:pick',
  workspaceScan: 'workspace:scan',
  envShape: 'env:shape',
  envCompare: 'env:compare',
  appInfo: 'app:info',
  workspaceRecent: 'workspace:recent',
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
  historyRollback: 'history:rollback'
} as const

/** Discovered file. Metadata only. Contents are not opened during a scan. */
export type EnvFileInfo = {
  path: string
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
  reason: 'apply' | 'rollback'
  mtime: number
  size: number
  keys: string[]
  /** False when no keyring could seal the bytes: shape recorded, content not restorable. */
  restorable: boolean
}

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
  pickWorkspace: () => Promise<string | null>
  scanWorkspace: (req: ScanRequest) => Promise<ScanResult>
  envShape: (req: ShapeRequest) => Promise<EnvShape>
  compareEnv: (req: CompareRequest) => Promise<DriftReceipt>
  appInfo: () => Promise<AppInfo>
  /** Last granted root, re-granted for this session, or null on first run. */
  recentWorkspace: () => Promise<string | null>
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
  onUpdate: (cb: (e: UpdateEvent) => void) => () => void
  installUpdate: () => Promise<void>
  /** Tray → "Compare again". */
  onTrayCompare: (cb: () => void) => () => void
  /** The only write path. Main snapshots the target first. */
  applyPlan: (req: ApplyRequest) => Promise<ApplyResult>
  listSnapshots: () => Promise<Snapshot[]>
  /** Restore a snapshot over its file (snapshotting the current content first). */
  rollback: (id: number) => Promise<void>
}
