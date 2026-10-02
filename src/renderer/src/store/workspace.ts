import { create } from 'zustand'
import { toast } from 'sonner'
import type { DriftReceipt } from '@shared/drift'
import type {
  DockerSourceSpec,
  EnvFileInfo,
  PairReceipt,
  ProjectCompareResult,
  ProjectSide,
  ProviderConnectSpec,
  RootInfo,
  ScanResult,
  SourceRoot,
  VaultSourceSpec,
  Workspace
} from '@shared/channels'

/** Keys expected to differ per environment. Never counted as drift. */
export const DEFAULT_IGNORE = ['NODE_ENV']

export const PAGES = [
  'workspace',
  'receipt',
  'sync',
  'share',
  'history',
  'agents',
  'settings'
] as const
export type PageId = (typeof PAGES)[number]

/** Redacted summary of one file: how many keys, how many blank. Never a value. */
/** What the Add/Update source dialog submits. */
export type SourceSpec =
  | { kind: 'local'; name: string }
  | { kind: 'ssh'; name: string; host: string; path: string }
  | ({ kind: 'docker'; name: string } & DockerSourceSpec)
  | ({ kind: 'vault' } & VaultSourceSpec)
  | { kind: 'provider'; name: string; spec: ProviderConnectSpec }
  | { kind: 'rename'; name: string }

export type KeySummary = { keys: number; blank: number; names: { key: string; blank: boolean }[] }

/** Group label for files outside any Git project. */
export const UNGROUPED = '(no git project)'
/** Projects are unique per root: the selection key carries both. */
export const projectKey = (f: { root: string; project: string | null }): string =>
  `${f.root}\u0000${f.project ?? UNGROUPED}`
export const splitProjectKey = (k: string): { root: string; project: string } => {
  const i = k.indexOf('\u0000')
  return { root: k.slice(0, i), project: k.slice(i + 1) }
}

const COLLAPSED_KEY = 'plumbr-sidebar-collapsed'
const readCollapsed = (): boolean => {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

type State = {
  page: PageId
  /** null until main answers. false shows the first-run journey. */
  onboarded: boolean | null
  setOnboarded: (v: boolean) => Promise<void>
  sidebarCollapsed: boolean
  toggleSidebar: () => void
  /** An open file viewer has unsaved edits: navigation and root changes must ask first. */
  viewerDirty: boolean
  setViewerDirty: (v: boolean) => void
  /** File open in the viewer. Lives here so switching project or source closes it. */
  openFile: EnvFileInfo | null
  setOpenFile: (f: EnvFileInfo | null) => void
  /** Workspace search: project name, file path, key name. Shared by sidebar and table. */
  search: string
  setSearch: (q: string) => void
  /** Sidebar width in px (expanded). */
  sidebarWidth: number
  setSidebarWidth: (w: number) => void
  /** macOS full screen hides the traffic lights; the top strip follows. */
  fullscreen: boolean
  /** Keys written this session, for the status bar. */
  written: number
  noteWritten: (n: number) => void
  /** Named workspaces; `workspace` is the active id. */
  workspaces: Workspace[]
  workspace: number
  loadWorkspaces: () => Promise<void>
  switchWorkspace: (id: number) => Promise<void>
  createWorkspace: (name: string, activate?: boolean) => Promise<void>
  renameWorkspace: (id: number, name: string) => Promise<void>
  deleteWorkspace: (id: number) => Promise<void>
  /** Granted roots: local folders and ssh://host/path. */
  roots: RootInfo[]
  /** Every root of every source (metadata only), for cross-source comparison and labels. */
  allRoots: SourceRoot[]
  /** Source label for any root, active or not. */
  labelFor: (root: string) => string
  /** Cross-source project comparison: the two chosen sides and the last result. */
  projectSides: { left: ProjectSide | null; right: ProjectSide | null }
  projectResult: ProjectCompareResult | null
  projectComparing: boolean
  pickProjectSide: (side: 'left' | 'right', s: ProjectSide | null) => void
  /** Scan both projects fresh, pair their environment files and compare each pair. */
  compareProjects: () => Promise<void>
  /** Drill into one pair: it becomes the A/B receipt. */
  openPair: (pair: PairReceipt) => void
  /** Files from every root, merged. `scan.root` is '' when several roots are granted. */
  scan: ScanResult | null
  scanning: boolean
  error: string | null
  /** projectKey() of the project whose overview is open. */
  project: string | null
  /** Per-file key summaries, loaded when a project is opened. */
  summaries: Record<string, KeySummary>
  left: EnvFileInfo | null
  right: EnvFileInfo | null
  receipt: DriftReceipt | null
  comparing: boolean
  setPage: (page: PageId) => void
  /** Re-grant the remembered root and rescan. Called once at launch. */
  init: () => Promise<void>
  /** Back to first run. */
  reset: () => void
  /** OS folder picker → add a local root to the active source. Resolves false if cancelled. */
  grant: () => Promise<boolean>
  /** Create a source (a workspace with one root) and make it active. Name defaults from the root. */
  createSource: (req: SourceSpec) => Promise<void>
  /** Rename the active source and, if the root changed, swap it. */
  updateSource: (req: SourceSpec) => Promise<void>
  addSsh: (host: string, path: string) => Promise<void>
  /** Verify with docker exec, then grant a container directory. */
  addDocker: (spec: DockerSourceSpec) => Promise<RootInfo>
  /** Preflight + connect a Vault source; the credential goes to main once and never returns. */
  addVault: (spec: VaultSourceSpec) => Promise<RootInfo>
  /** Preflight + connect a read-only provider; tokens go to main once and never return. */
  addProvider: (spec: ProviderConnectSpec) => Promise<RootInfo>
  removeRoot: (path: string) => Promise<void>
  rescan: () => Promise<void>
  openProject: (project: string | null) => Promise<void>
  pick: (side: 'left' | 'right', file: EnvFileInfo | null) => void
  swap: () => void
  compare: () => Promise<void>
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export const useWorkspace = create<State>((set, get) => ({
  page: 'workspace',
  onboarded: null,
  setOnboarded: async (v) => {
    await window.plumbr.setSettings({ onboarded: v })
    set({ onboarded: v })
  },
  viewerDirty: false,
  setViewerDirty: (v) => set({ viewerDirty: v }),
  openFile: null,
  setOpenFile: (f) => set({ openFile: f }),
  search: '',
  setSearch: (q) => set({ search: q }),
  sidebarWidth: (() => {
    try {
      return Math.min(
        480,
        Math.max(200, Number(localStorage.getItem('plumbr-sidebar-width')) || 260)
      )
    } catch {
      return 260
    }
  })(),
  setSidebarWidth: (w) => {
    const v = Math.min(480, Math.max(200, Math.round(w)))
    try {
      localStorage.setItem('plumbr-sidebar-width', String(v))
    } catch {
      /* ignore */
    }
    set({ sidebarWidth: v })
  },
  fullscreen: false,
  written: 0,
  noteWritten: (n) => set((s) => ({ written: s.written + n })),
  sidebarCollapsed: readCollapsed(),
  toggleSidebar: () =>
    set((s) => {
      const next = !s.sidebarCollapsed
      try {
        localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0')
      } catch {
        /* private mode or blocked storage: the toggle still works for this session */
      }
      return { sidebarCollapsed: next }
    }),
  workspaces: [],
  workspace: 1,
  loadWorkspaces: async () => {
    const [{ active, all }, allRoots] = await Promise.all([
      window.plumbr.listWorkspaces(),
      window.plumbr.rootsAll()
    ])
    set({ workspaces: all, workspace: active, allRoots })
  },
  switchWorkspace: async (id) => {
    if (get().viewerDirty && !window.confirm('Discard unsaved changes to the open file?')) return
    const roots = await window.plumbr.switchWorkspace(id)
    set({
      workspace: id,
      roots,
      scan: null,
      project: null,
      summaries: {},
      left: null,
      right: null,
      receipt: null,
      projectSides: { left: null, right: null },
      projectResult: null,
      error: null,
      viewerDirty: false,
      openFile: null,
      page: 'workspace'
    })
    await get().loadWorkspaces()
    if (roots.length) await get().rescan()
  },
  createWorkspace: async (name, activate = true) => {
    const w = await window.plumbr.createWorkspace(name)
    await get().loadWorkspaces()
    if (activate) await get().switchWorkspace(w.id)
  },
  renameWorkspace: async (id, name) => {
    await window.plumbr.renameWorkspace({ id, name })
    await get().loadWorkspaces()
  },
  deleteWorkspace: async (id) => {
    const wasActive = get().workspace === id
    await window.plumbr.deleteWorkspace(id)
    await get().loadWorkspaces()
    // Main already picked a fallback; re-enter it so roots, scan and selection follow.
    if (wasActive) await get().switchWorkspace(get().workspace)
  },
  roots: [],
  allRoots: [],
  labelFor: (root) => get().allRoots.find((r) => r.path === root)?.label ?? root,
  projectSides: { left: null, right: null },
  projectResult: null,
  projectComparing: false,
  pickProjectSide: (side, s) =>
    set((st) => ({ projectSides: { ...st.projectSides, [side]: s }, projectResult: null })),
  compareProjects: async () => {
    const { left, right } = get().projectSides
    if (!left || !right) return
    set({ projectComparing: true, error: null })
    try {
      const projectResult = await window.plumbr.projectCompare({ left, right })
      const now = get()
      if (now.projectSides.left !== left || now.projectSides.right !== right) return
      // The open pair may come from a source the rescan does not cover (inactive source):
      // re-point it at the fresh metadata (mtime/version) so the next apply quotes the truth.
      const pair = projectResult.pairs.find(
        (p) => p.left.path === now.left?.path && p.right.path === now.right?.path
      )
      set(pair ? { projectResult, left: pair.left, right: pair.right } : { projectResult })
    } catch (e) {
      set({ error: message(e) })
    } finally {
      set({ projectComparing: false })
    }
  },
  openPair: (pair) =>
    set({
      left: pair.left,
      right: pair.right,
      receipt: pair.receipt,
      error: null,
      page: 'receipt'
    }),
  scan: null,
  scanning: false,
  error: null,
  project: null,
  summaries: {},
  left: null,
  right: null,
  receipt: null,
  comparing: false,

  setPage: (page) => {
    const s = get()
    if (
      s.viewerDirty &&
      page !== s.page &&
      !window.confirm('Discard unsaved changes to the open file?')
    )
      return
    if (page !== 'workspace') set({ viewerDirty: false })
    set({ page })
  },

  init: async () => {
    set({ onboarded: (await window.plumbr.getSettings()).onboarded })
    await get().loadWorkspaces()
    const roots = await window.plumbr.recentWorkspaces()
    if (roots.length === 0) return
    set({ roots })
    await get().rescan()
  },

  reset: () =>
    set({
      roots: [],
      scan: null,
      project: null,
      summaries: {},
      left: null,
      right: null,
      receipt: null,
      projectSides: { left: null, right: null },
      projectResult: null,
      error: null,
      page: 'workspace'
    }),

  grant: async () => {
    if (get().viewerDirty && !window.confirm('Discard unsaved changes to the open file?'))
      return false
    set({ viewerDirty: false })
    const root = await window.plumbr.pickWorkspace()
    if (!root) return false
    set((s) => ({
      roots: s.roots.some((r) => r.path === root.path) ? s.roots : [...s.roots, root]
    }))
    void get().loadWorkspaces()
    await get().rescan()
    return true
  },

  createSource: async (req) => {
    if (req.kind === 'rename') return
    const before = get().workspace
    const name =
      req.name.trim() ||
      (req.kind === 'ssh'
        ? `${req.host}:${req.path}`
        : req.kind === 'docker'
          ? `${req.container}:${req.path}`
          : req.kind === 'vault'
            ? `vault:${req.path}`
            : req.kind === 'provider'
              ? req.spec.provider
              : 'New source')
    const w = await window.plumbr.createWorkspace(name)
    await get().loadWorkspaces()
    await get().switchWorkspace(w.id)
    try {
      if (req.kind === 'ssh') {
        await get().addSsh(req.host, req.path)
      } else if (req.kind === 'docker') {
        await get().addDocker(req)
      } else if (req.kind === 'vault') {
        const root = await get().addVault(req)
        if (!req.name.trim()) await get().renameWorkspace(w.id, root.label)
      } else if (req.kind === 'provider') {
        const root = await get().addProvider(req.spec)
        if (!req.name.trim()) await get().renameWorkspace(w.id, root.label)
      } else {
        const ok = await get().grant()
        if (!ok) throw new Error('cancelled')
        // Default the name from the folder when the user left it blank.
        if (!req.name.trim()) {
          const path = get().roots[0]?.path ?? ''
          const base = path.split(/[\\/]/).filter(Boolean).pop()
          if (base) await get().renameWorkspace(w.id, base)
        }
      }
    } catch (e) {
      // Nothing got connected: drop the empty source and go back.
      await window.plumbr.deleteWorkspace(w.id).catch(() => {})
      await get().loadWorkspaces()
      await get().switchWorkspace(before)
      if (!(e instanceof Error && e.message === 'cancelled')) throw e
    }
  },

  updateSource: async (req) => {
    if (get().viewerDirty && !window.confirm('Discard unsaved changes to the open file?')) return
    set({ viewerDirty: false, openFile: null })
    const id = get().workspace
    const current = get().workspaces.find((w) => w.id === id)
    if (!current) return
    if (req.name.trim() && req.name.trim() !== current.name)
      await get().renameWorkspace(id, req.name.trim())
    const old = get().roots[0]
    if (req.kind === 'ssh') {
      const next = `ssh://${req.host}${req.path.replace(/\/+$/, '') || '/'}`
      if (old?.path !== next) {
        await get().addSsh(req.host, req.path)
        if (old) await get().removeRoot(old.path)
      }
    } else if (req.kind === 'docker') {
      const next = `docker://${req.host ?? ''}/${req.container}${req.path.replace(/\/+$/, '') || '/'}`
      if (old?.path !== next) {
        await get().addDocker(req)
        if (old) await get().removeRoot(old.path)
      }
    } else if (req.kind === 'vault' || req.kind === 'provider') {
      // Reconnect: a fresh connection replaces the old root (and its stored credential).
      if (req.kind === 'vault') await get().addVault(req)
      else await get().addProvider(req.spec)
      if (old) await get().removeRoot(old.path)
    } else if (req.kind === 'local') {
      // The caller passes kind 'local' only when the user chose a different directory.
      const ok = await get().grant()
      const picked = get().roots.find((r) => r.path !== old?.path)
      if (ok && old && picked && picked.path !== old.path) await get().removeRoot(old.path)
    }
    await get().loadWorkspaces()
  },

  addSsh: async (host, path) => {
    const root = await window.plumbr.addSshRoot({ host, path })
    set((s) => ({
      roots: s.roots.some((r) => r.path === root.path) ? s.roots : [...s.roots, root]
    }))
    void get().loadWorkspaces()
    await get().rescan()
  },

  addDocker: async (spec) => {
    const root = await window.plumbr.addDockerRoot(spec)
    set((s) => ({
      roots: s.roots.some((r) => r.path === root.path) ? s.roots : [...s.roots, root]
    }))
    void get().loadWorkspaces()
    await get().rescan()
    return root
  },

  addProvider: async (spec) => {
    const { root, summary, warnings } = await window.plumbr.providerConnect(spec)
    set((s) => ({
      roots: s.roots.some((r) => r.path === root.path) ? s.roots : [...s.roots, root]
    }))
    toast.success(`Connected ${root.label}`, { description: summary })
    if (warnings.length) toast.warning('Connection notes', { description: warnings.join(' ') })
    void get().loadWorkspaces()
    await get().rescan()
    return root
  },

  addVault: async (spec) => {
    const { root, preflight } = await window.plumbr.vaultConnect(spec)
    set((s) => ({
      roots: s.roots.some((r) => r.path === root.path) ? s.roots : [...s.roots, root]
    }))
    toast.success(`Connected ${root.label}`, {
      description: `${preflight.kind === 'folder' ? 'Folder of environments' : 'One environment'} · Vault ${preflight.vaultVersion} · token ${
        preflight.token.displayName || preflight.token.accessor
      } (${preflight.token.policies.join(', ')})`
    })
    if (preflight.warnings.length)
      toast.warning('Vault connection notes', { description: preflight.warnings.join(' ') })
    void get().loadWorkspaces()
    await get().rescan()
    return root
  },

  removeRoot: async (path) => {
    if (get().viewerDirty && !window.confirm('Discard unsaved changes to the open file?')) return
    await window.plumbr.removeRoot(path)
    set((s) => {
      const drop = (f: EnvFileInfo | null): EnvFileInfo | null => (f && f.root === path ? null : f)
      const left = drop(s.left)
      const right = drop(s.right)
      return {
        viewerDirty: false,
        roots: s.roots.filter((r) => r.path !== path),
        left,
        right,
        receipt: left === s.left && right === s.right ? s.receipt : null,
        project: s.project && splitProjectKey(s.project).root === path ? null : s.project
      }
    })
    void get().loadWorkspaces()
    if (get().roots.length === 0) set({ scan: null, project: null, summaries: {} })
    else await get().rescan()
  },

  rescan: async () => {
    const { roots, project } = get()
    if (roots.length === 0) return
    set({ scanning: true, error: null })
    try {
      // Each root scans independently; one failing root reports, the others still load.
      const results = await Promise.allSettled(
        roots.map((r) => window.plumbr.scanWorkspace({ root: r.path }))
      )
      const ok = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []))
      const failed = results
        .map((r, i) => (r.status === 'rejected' ? `${roots[i].label}: ${message(r.reason)}` : null))
        .filter((m): m is string => m !== null)
      if (ok.length === 0) throw new Error(failed.join('\n'))
      if (failed.length) set({ error: failed.join('\n') })
      const files = ok.flatMap((s) => s.files)
      const scan: ScanResult = {
        root: roots.length === 1 ? roots[0].path : '',
        files,
        projects: [...new Set(files.map(projectKey))],
        scannedDirs: ok.reduce((n, s) => n + s.scannedDirs, 0),
        durationMs: Math.max(...ok.map((s) => s.durationMs))
      }
      // Summaries are only dropped once a fresh scan has replaced the file list.
      set({ summaries: {} })
      const groups = new Set(files.map(projectKey))
      const keep = project && groups.has(project) ? project : (scan.projects[0] ?? null)
      set({ scan })
      // Selections may point at files that no longer exist.
      // Re-point the pair at the fresh metadata (mtime/size) or drop files that vanished.
      // A side from another source (cross-source pair) is not in this scan and is kept as is.
      const byPath = new Map(scan.files.map((f) => [f.path, f]))
      const active = new Set(roots.map((r) => r.path))
      const repoint = (f: EnvFileInfo | null): EnvFileInfo | null =>
        f && active.has(f.root) ? (byPath.get(f.path) ?? null) : f
      const { left, right } = get()
      const l = repoint(left)
      const r = repoint(right)
      if ((left && !l) || (right && !r)) set({ left: l, right: r, receipt: null })
      else set({ left: l, right: r })
      await get().openProject(keep)
    } catch (e) {
      set({ error: message(e) })
    } finally {
      set({ scanning: false })
    }
  },

  openProject: async (project) => {
    set((s) => ({ project, openFile: s.project === project ? s.openFile : null }))
    const { scan, summaries } = get()
    if (!project || !scan) return
    const todo = scan.files.filter((f) => projectKey(f) === project && !(f.path in summaries))
    // ponytail: one envShape call per file, sequential. Batch IPC if projects with 50+ env files show up.
    for (const f of todo) {
      try {
        const shape = await window.plumbr.envShape({ path: f.path })
        set((s) => ({
          summaries: {
            ...s.summaries,
            [f.path]: {
              keys: shape.entries.length,
              blank: shape.entries.filter((e) => e.fingerprint === null).length,
              names: shape.entries.map((e) => ({ key: e.key, blank: e.fingerprint === null }))
            }
          }
        }))
      } catch (e) {
        set({ error: message(e) })
      }
    }
  },

  // A new pair starts clean: a stale summary error must not block auto-compare.
  pick: (side, file) => set({ [side]: file, receipt: null, error: null }),

  swap: () => set((s) => ({ left: s.right, right: s.left, receipt: null, error: null })),

  compare: async () => {
    const { left, right } = get()
    if (!left || !right) return
    set({ comparing: true, error: null })
    try {
      const receipt = await window.plumbr.compareEnv({
        left: left.path,
        right: right.path,
        ignore: DEFAULT_IGNORE
      })
      // The pair may have been swapped or changed while main was comparing; a receipt
      // for a stale pair must never land under a header that names a different one.
      const now = get()
      if (now.left?.path === left.path && now.right?.path === right.path) set({ receipt })
    } catch (e) {
      set({ error: message(e) })
    } finally {
      set({ comparing: false })
    }
  }
}))
