import { create } from 'zustand'
import type { DriftReceipt } from '@shared/drift'
import type { EnvFileInfo, ScanResult } from '@shared/channels'

/** Keys expected to differ per environment. Never counted as drift. */
export const DEFAULT_IGNORE = ['NODE_ENV']

type State = {
  root: string | null
  scan: ScanResult | null
  scanning: boolean
  error: string | null
  left: EnvFileInfo | null
  right: EnvFileInfo | null
  receipt: DriftReceipt | null
  comparing: boolean
  grant: () => Promise<void>
  rescan: () => Promise<void>
  pick: (side: 'left' | 'right', file: EnvFileInfo) => void
  compare: () => Promise<void>
}

export const useWorkspace = create<State>((set, get) => ({
  root: null,
  scan: null,
  scanning: false,
  error: null,
  left: null,
  right: null,
  receipt: null,
  comparing: false,

  grant: async () => {
    const root = await window.plumbr.pickWorkspace()
    if (!root) return
    set({ root, left: null, right: null, receipt: null })
    await get().rescan()
  },

  rescan: async () => {
    const { root } = get()
    if (!root) return
    set({ scanning: true, error: null })
    try {
      const scan = await window.plumbr.scanWorkspace({ root })
      set({ scan })
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) })
    } finally {
      set({ scanning: false })
    }
  },

  pick: (side, file) => set({ [side]: file, receipt: null }),

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
      set({ receipt })
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) })
    } finally {
      set({ comparing: false })
    }
  }
}))
