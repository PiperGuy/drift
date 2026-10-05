/**
 * Channel names and the types that cross the bridge. This file must stay
 * free of runtime dependencies: the sandboxed preload imports it and cannot
 * require anything but `electron`. Validation schemas live in ./ipc.ts.
 * Values never cross the bridge: only key names, fingerprints and classes.
 */
import type { DriftReceipt, KeyEntry } from './drift'
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
  updateCheck: 'update:check',
  mcpClients: 'mcp:clients',
  mcpInstall: 'mcp:install',
  mcpUninstall: 'mcp:uninstall',
  envReveal: 'env:reveal',
  updateEvent: 'update:event',
  updateInstall: 'update:install',
  envApply: 'env:apply',
  historySnapshots: 'history:snapshots',
  historyRollback: 'history:rollback',
  envView: 'env:view',
  envFormat: 'env:format',
  envSet: 'env:set',
  envRevealAll: 'env:reveal-all',
  windowFullscreen: 'window:fullscreen',
  windowTheme: 'window:theme',
  sshHosts: 'ssh:hosts',
  vaultConnect: 'vault:connect',
  vaultHistory: 'vault:history',
  vaultShapeAt: 'vault:shape-at',
  vaultRestore: 'vault:restore',
  vaultDiscover: 'vault:discover',
  vaultDiscoverMount: 'vault:discover-mount',
  vaultDiscoverList: 'vault:discover-list',
  vaultDiscoverVersions: 'vault:discover-versions',
  vaultDiscoverEnd: 'vault:discover-end',
  providerConnect: 'provider:connect',
  workspaceAddDocker: 'workspace:add-docker',
  dockerContainers: 'docker:containers',
  awsProfiles: 'aws:profiles',
  ecsDiscover: 'ecs:discover',
  rootsAll: 'roots:all',
  projectCompare: 'project:compare'
} as const

/** A source the user switches between: a named set of roots (usually one). `path` is its first root. */
export type Workspace = { id: number; name: string; roots: number; path: string | null }
/** Every remembered root across every source, for the cross-source picker. */
export type SourceRoot = RootInfo & { workspace: number; workspaceName: string }

/**
 * API providers. Each is `<id>://<connectionId>/<target>` as a root and file
 * ref; the adapter lives in src/main/providers/<id>. Reads render `.env` text;
 * writes go through the adapter's `apply` behind the plan flow (never through a
 * file write). The MCP process never touches them directly: an agent reaches
 * them only through the app's bridge (src/main/bridge.ts), which runs the same
 * plan flow.
 */
export const PROVIDERS = [
  'ecs',
  'aws-sm',
  'vercel',
  'github',
  'railway',
  'render',
  'dokploy',
  'coolify'
] as const
export type ProviderId = (typeof PROVIDERS)[number]

/** A granted root: a local folder, ssh://host/path, docker://host/container/path, vault://…, or a provider ref. */
export type RootKind = 'local' | 'ssh' | 'docker' | 'vault' | ProviderId
export type RootInfo = {
  path: string
  kind: RootKind
  label: string
  /** aws-sm only: the path is a `prefix/` (folder of secrets), not one secret. Refs cannot carry the slash. */
  prefix?: true
}

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
  /** Vault only: the KV v2 version this metadata describes. The CAS base for writes. */
  version?: number
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
  | 'mcp_install'
  | 'mcp_uninstall'
  | 'reveal'
  | 'apply'
  | 'rollback'
  | 'format'
  | 'edit'
  | 'connection'
export type HistoryEvent = {
  id: number
  at: number
  /**
   * Event kinds are persisted in an append-only SQLite table. Keep this broad so
   * newer builds can still display rows written by removed or future features.
   * `HistoryKind` remains the restricted set accepted by logEvent for new rows.
   */
  kind: string
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
  /** Vault targets: the KV v2 version the plan was built from (the CAS base). */
  expectedVersion?: number
  /**
   * The stored receipt the plan came from. Main re-reads both sides and refuses
   * when either shape moved since. Required for provider targets.
   */
  receipt?: number
}
export type ApplyResult = {
  written: string[]
  skipped: { key: string; reason: string }[]
  snapshot: number
  /** Vault targets: the version the write moved the secret from and to. */
  version?: { base: number; next: number }
  /** Vault and provider targets: the target was read back and the written values match the plan. */
  verified?: boolean
  /** Provider targets: what the read-back could and could not confirm, and any deployment effect. */
  note?: string
}

/* ---------- Cross-source project comparison ---------- */

/** One side of a project comparison: a remembered root and a project inside it (null = ungrouped files). */
export type ProjectSide = { root: string; project: string | null }
export type ProjectCompareRequest = { left: ProjectSide; right: ProjectSide }
/** One matched environment file pair with its receipt, or the reason the compare failed. */
export type PairReceipt = {
  /** The relative environment-file identity both files share (see shared/pairing.ts). */
  id: string
  left: EnvFileInfo
  right: EnvFileInfo
  receipt: DriftReceipt | null
  error: string | null
}
export type ProjectCompareResult = {
  left: ProjectSide & { files: number }
  right: ProjectSide & { files: number }
  pairs: PairReceipt[]
  onlyLeft: EnvFileInfo[]
  onlyRight: EnvFileInfo[]
  /** Files sharing an identity with another file on their side: never paired. */
  ambiguous: EnvFileInfo[]
}

/* ---------- HashiCorp Vault KV v2 ---------- */

export type VaultAuth =
  | { kind: 'token'; token: string }
  | { kind: 'approle'; roleId: string; secretId: string }
  /** Reuse the token a Browse Vault session already resolved in main. */
  | { kind: 'session'; session: string }

/** What the Add source dialog submits. The credential is used in main and never returned. */
export type VaultSourceSpec = {
  name: string
  /** https://host:8200 — plain http only on loopback (e.g. a local Vault Proxy). */
  address: string
  /** Enterprise / HCP only. HCP Vault Dedicated: usually "admin". */
  namespace?: string
  /** PEM CA bundle for self-signed clusters. Not a secret. */
  caPem?: string
  /** Mount and secret path in one, e.g. "secret/apps/api/prod" (leaf) or "secret/apps/api" (folder). */
  path: string
  auth: VaultAuth
  /** 'keychain' seals the resolved token via safeStorage; 'session' keeps it in memory only. */
  storage: 'session' | 'keychain'
}

export type VaultTokenInfo = {
  accessor: string
  displayName: string
  policies: string[]
  expireTime: string | null
  renewable: boolean
  type: 'service' | 'batch'
}

export type VaultPreflight = {
  vaultVersion: string
  enterprise: boolean
  mount: string
  kind: 'leaf' | 'folder'
  casRequired: boolean
  maxVersions: number
  deleteVersionAfter: string
  token: VaultTokenInfo
  capabilities: Record<string, string[]>
  warnings: string[]
}

export type VaultConnectResult = { root: RootInfo; preflight: VaultPreflight }

/** Sign in once to browse. Same fields as a source, minus the name, path and storage. */
export type VaultDiscoverSpec = Pick<VaultSourceSpec, 'address' | 'namespace' | 'caPem'> & {
  auth: Exclude<VaultAuth, { kind: 'session' }>
}

/** One KV v2 mount (other engines and KV v1 are counted, not listed). */
export type VaultMount = { path: string; description: string }

export type VaultDiscovery = {
  /** Opaque id of the main-process session that holds the token. Not a credential. */
  session: string
  vaultVersion: string
  token: VaultTokenInfo
  /** null: this token may not enumerate mounts; browse a mount you name instead. */
  mounts: VaultMount[] | null
  /** Why mounts is null, or how many non-KV-v2 mounts were left out. */
  mountsNote: string | null
  warnings: string[]
}

/** A child under a mount: a folder of secrets/apps or one secret document. Names only. */
export type VaultNode = { name: string; path: string; kind: 'folder' | 'secret' }

export type VaultListing =
  | { state: 'ok'; nodes: VaultNode[]; truncated: boolean }
  /** Vault answers 404 both for an empty folder and for a missing list permission. */
  | { state: 'empty' }
  | { state: 'error'; denied: boolean; message: string }

export type VaultVersionMeta = {
  version: number
  createdTime: string
  deletionTime: string | null
  destroyed: boolean
  createdBy?: { actor?: string; operation?: string; entityId?: string }
}

export type VaultHistory = {
  path: string
  currentVersion: number
  /** Versions below this rolled off (max_versions). 0 = nothing rolled off yet. */
  oldestVersion: number
  maxVersions: number
  casRequired: boolean
  deleteVersionAfter: string
  updatedTime: string
  versions: VaultVersionMeta[]
}

/* ---------- Read-only API providers, Docker, AWS ---------- */

export type ProviderStorage = 'session' | 'keychain'

/**
 * What the Add source dialog submits for a provider. Tokens are used in main and
 * never returned; AWS entries carry no credential at all (the SDK credential
 * chain — profiles, SSO, env — is used, and only region + profile are stored).
 */
export type ProviderConnectSpec =
  | {
      provider: 'vercel'
      name: string
      token: string
      /** Team-owned projects need the team id (team_…) or slug. */
      teamId?: string
      /** Project id (prj_…) or name. */
      project: string
      storage: ProviderStorage
    }
  | {
      provider: 'github'
      name: string
      token: string
      owner: string
      /** Empty = organization-level secrets and variables. */
      repo?: string
      storage: ProviderStorage
    }
  | { provider: 'railway'; name: string; token: string; project: string; storage: ProviderStorage }
  | { provider: 'render'; name: string; token: string; storage: ProviderStorage }
  | {
      provider: 'dokploy'
      name: string
      token: string
      address: string
      caPem?: string
      storage: ProviderStorage
    }
  | {
      provider: 'coolify'
      name: string
      token: string
      address: string
      caPem?: string
      storage: ProviderStorage
    }
  | {
      provider: 'aws-sm'
      name: string
      region: string
      profile?: string
      /** One secret name, or a name prefix ending in `/` for a folder of secrets. */
      secret: string
    }
  | {
      provider: 'ecs'
      name: string
      region: string
      profile?: string
      cluster: string
      /** `service:<name>` (recommended: survives deployments) or `task:<id>`. */
      selector: string
      container: string
      /**
       * Empty: read the task definition's environment through the API (no command
       * runs). A directory: read files inside the running container with ECS Exec.
       */
      path?: string
    }

export type ProviderConnectResult = {
  root: RootInfo
  /** One line for the toast: what was found. */
  summary: string
  warnings: string[]
}

export type DockerSourceSpec = { host?: string; container: string; path: string }

export type EcsDiscoverRequest = { region: string; profile?: string; cluster?: string }
export type EcsDiscovery = {
  clusters: string[]
  services: { name: string; taskDefinition: string; running: number; containers: string[] }[]
  tasks: { id: string; family: string; lastStatus: string; containers: string[] }[]
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
  /** `Host` aliases from ~/.ssh/config, for the source dialog. Names only. */
  sshHosts: () => Promise<string[]>
  /** Keep the native window appearance (and its vibrancy material) on the app's theme. */
  setWindowTheme: (theme: 'system' | 'light' | 'dark') => void
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
  /** Preflight + connect a Vault KV v2 source. The credential never comes back. */
  vaultConnect: (spec: VaultSourceSpec) => Promise<VaultConnectResult>
  /** Version timeline of one Vault environment (metadata only, no values). */
  vaultHistory: (path: string) => Promise<VaultHistory>
  /** Redacted shape of one historical version, fetched on demand. */
  vaultShapeAt: (req: { path: string; version: number }) => Promise<EnvShape>
  /** Write vN's data as a new version, CAS-guarded on the current one. */
  vaultRestore: (req: {
    path: string
    version: number
    expectedVersion: number
  }) => Promise<ApplyResult>
  /** Sign in once and enumerate KV v2 mounts. Metadata only; the token stays in main. */
  vaultDiscover: (spec: VaultDiscoverSpec) => Promise<VaultDiscovery>
  /** Resolve a typed path to its KV v2 mount (for tokens that cannot enumerate mounts). */
  vaultDiscoverMount: (req: {
    session: string
    path: string
  }) => Promise<{ mount: VaultMount; folder: string; secret: boolean }>
  /** One level of <mount>/metadata/<folder>, loaded lazily on expansion. Names only. */
  vaultDiscoverList: (req: {
    session: string
    mount: string
    folder: string
  }) => Promise<VaultListing>
  /** Version timeline of one secret while browsing (metadata only, no values). */
  vaultDiscoverVersions: (req: {
    session: string
    mount: string
    path: string
  }) => Promise<VaultHistory>
  /** Forget a browse session's token. */
  vaultDiscoverEnd: (session: string) => Promise<void>
  /** Preflight + connect a read-only provider source. Tokens never come back. */
  providerConnect: (spec: ProviderConnectSpec) => Promise<ProviderConnectResult>
  /** Verify with `docker exec`, then grant and remember a container directory. */
  addDockerRoot: (req: DockerSourceSpec) => Promise<RootInfo>
  /** Running container names on the local daemon or an ssh://host daemon. */
  dockerContainers: (host?: string) => Promise<string[]>
  /** Profile names from ~/.aws/config and ~/.aws/credentials. Names only. */
  awsProfiles: () => Promise<string[]>
  /** Clusters, or one cluster's services and running tasks with their containers. */
  ecsDiscover: (req: EcsDiscoverRequest) => Promise<EcsDiscovery>
  /** Every remembered root of every source (metadata only), for the cross-source picker. */
  rootsAll: () => Promise<SourceRoot[]>
  /** Scan two projects (any two sources), pair their environment files and compare each pair. */
  projectCompare: (req: ProjectCompareRequest) => Promise<ProjectCompareResult>
}
