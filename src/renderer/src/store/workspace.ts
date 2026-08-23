import { create } from 'zustand'
import type { DriftReceipt } from '@shared/drift'
import type { EnvFileInfo, ScanResult } from '@shared/channels'
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
  /** Keys written this session, for the status bar. */
  written: number
  noteWritten: (n: number) => void
  root: string | null
  scan: ScanResult | null
  scanning: boolean
  error: string | null
  /** Project (relative path) whose environment overview is open. */
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
  grant: () => Promise<void>
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
  root: null,
  scan: null,
  scanning: false,
  error: null,
  project: null,
  summaries: {},
  left: null,
  right: null,
  receipt: null,
  comparing: false,

  setPage: (page) => set({ page }),

  init: async () => {
    const license = await window.plumbr.getLicense()
    set({ license })
    if (license.state === 'expired') return
    set({ onboarded: (await window.plumbr.getSettings()).onboarded })
    const root = await window.plumbr.recentWorkspace()
    if (!root) return
    set({ root })
    await get().rescan()
  },

  reset: () =>
    set({
      root: null,
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
    const root = await window.plumbr.pickWorkspace()
    if (!root) return
    set({ root, scan: null, project: null, summaries: {}, left: null, right: null, receipt: null })
    await get().rescan()
  },

  rescan: async () => {
    const { root, project } = get()
    if (!root) return
    set({ scanning: true, error: null })
    try {
      const scan = await window.plumbr.scanWorkspace({ root })
      // Summaries are only dropped once a fresh scan has replaced the file list.
      set({ summaries: {} })
      const groups = new Set(scan.files.map((f) => f.project ?? UNGROUPED))
      const keep = project && groups.has(project) ? project : (scan.projects[0] ?? null)
      set({ scan })
      // Selections may point at files that no longer exist.
      const paths = new Set(scan.files.map((f) => f.path))
      const { left, right } = get()
      if ((left && !paths.has(left.path)) || (right && !paths.has(right.path))) {
        set({
          left: left && paths.has(left.path) ? left : null,
          right: right && paths.has(right.path) ? right : null,
          receipt: null
        })
      }
      await get().openProject(keep ?? (groups.has(UNGROUPED) ? UNGROUPED : null))
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
    const todo = scan.files.filter(
      (f) => (f.project ?? UNGROUPED) === project && !(f.path in summaries)
    )
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
