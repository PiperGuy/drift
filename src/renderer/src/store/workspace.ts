import { create } from 'zustand'
import type { DriftReceipt } from '@shared/drift'
import type { EnvFileInfo, RootInfo, ScanResult, Workspace } from '@shared/channels'
import type { LicenseState } from '@shared/license'

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
  /** null until main has answered; 'expired' locks the whole window. */
  license: LicenseState | null
  /** null until main answers. false shows the first-run journey. */
  onboarded: boolean | null
  setOnboarded: (v: boolean) => Promise<void>
  setLicense: (license: LicenseState) => void
  sidebarCollapsed: boolean
  toggleSidebar: () => void
  /** An open file viewer has unsaved edits: navigation and root changes must ask first. */
  viewerDirty: boolean
  setViewerDirty: (v: boolean) => void
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
  /** OS folder picker → add a local root. */
  grant: () => Promise<void>
  addSsh: (host: string, path: string) => Promise<void>
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
  license: null,
  onboarded: null,
  setOnboarded: async (v) => {
    await window.plumbr.setSettings({ onboarded: v })
    set({ onboarded: v })
  },
  setLicense: (license) => set({ license }),
  viewerDirty: false,
  setViewerDirty: (v) => set({ viewerDirty: v }),
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
    const { active, all } = await window.plumbr.listWorkspaces()
    set({ workspaces: all, workspace: active })
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
      error: null,
      viewerDirty: false,
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
    await window.plumbr.deleteWorkspace(id)
    await get().loadWorkspaces()
    if (get().workspace === id) await get().switchWorkspace(get().workspaces[0].id)
  },
  roots: [],
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
    const license = await window.plumbr.getLicense()
    set({ license })
    if (license.state === 'expired') return
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
      error: null,
      page: 'workspace'
    }),

  grant: async () => {
    if (get().viewerDirty && !window.confirm('Discard unsaved changes to the open file?')) return
    set({ viewerDirty: false })
    const root = await window.plumbr.pickWorkspace()
    if (!root) return
    set((s) => ({
      roots: s.roots.some((r) => r.path === root.path) ? s.roots : [...s.roots, root]
    }))
    void get().loadWorkspaces()
    await get().rescan()
  },

  addSsh: async (host, path) => {
    const root = await window.plumbr.addSshRoot({ host, path })
    set((s) => ({
      roots: s.roots.some((r) => r.path === root.path) ? s.roots : [...s.roots, root]
    }))
    void get().loadWorkspaces()
    await get().rescan()
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
      const byPath = new Map(scan.files.map((f) => [f.path, f]))
      const { left, right } = get()
      const l = left ? (byPath.get(left.path) ?? null) : null
      const r = right ? (byPath.get(right.path) ?? null) : null
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
    set({ project })
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
