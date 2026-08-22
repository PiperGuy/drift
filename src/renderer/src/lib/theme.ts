import { flushSync } from 'react-dom'

type VT = Document & { startViewTransition?: (cb: () => Promise<void> | void) => unknown }

/**
 * Apply a theme change inside a View Transition so light and dark crossfade
 * instead of flashing. Falls back to a plain set where the API is missing or
 * the user prefers reduced motion.
 */
export function transitionTheme(set: (theme: string) => void, theme: string): void {
  const doc = document as VT
  if (!doc.startViewTransition || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    set(theme)
    return
  }
  doc.startViewTransition(async () => {
    flushSync(() => set(theme))
    // next-themes swaps the class in an effect; give it one task before the new frame is captured.
    await new Promise((r) => setTimeout(r, 0))
  })
}
