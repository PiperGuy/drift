import type { PlumbrApi } from '../shared/channels'

declare global {
  interface Window {
    plumbr: PlumbrApi
  }
}

export {}
