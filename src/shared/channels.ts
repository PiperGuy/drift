/**
 * Channel names and the types that cross the bridge. This file must stay
 * free of runtime dependencies: the sandboxed preload imports it and cannot
 * require anything but `electron`. Validation schemas live in ./ipc.ts.
 * Values never cross the bridge: only key names, fingerprints and classes.
 */
import type { DriftReceipt, KeyEntry } from './drift'

export const Channels = {
  workspacePick: 'workspace:pick',
  workspaceScan: 'workspace:scan',
  envShape: 'env:shape',
  envCompare: 'env:compare',
  appInfo: 'app:info',
  workspaceRecent: 'workspace:recent',
  historyList: 'history:list',
  dataForget: 'data:forget'
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
export type HistoryKind = 'grant' | 'scan' | 'compare' | 'forget'
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
  mcp: { command: string; args: string[]; env: Record<string, string> }
}

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
}
