import type { BrowserWindowConstructorOptions } from 'electron'

/** The opaque window colour wherever there is no native glass. */
export const OPAQUE_BACKGROUND = '#08090a'

/**
 * Platform window chrome. macOS: the real system traffic lights, in their own
 * strip above the sidebar header (see App.tsx), and real NSVisualEffectView
 * vibrancy behind the shell. Vibrancy alone makes the window translucent:
 * Electron's NativeWindow::IsTranslucent() is true on macOS when a vibrancy is
 * set, and with no backgroundColor it then gives the web contents a transparent
 * background. So there is deliberately no backgroundColor here, and no
 * `transparent: true` either: that adds nothing for vibrancy and costs the
 * native window shadow and reliable resizing (Electron's transparent-window
 * limitations). The renderer paints an opaque content sheet over the glass
 * (html[data-glass]) and macOS itself goes solid under Reduce Transparency.
 * Every other platform gets an opaque window: no vibrancy, no transparency.
 */
export function platformWindowOptions(
  platform: NodeJS.Platform
): Pick<
  BrowserWindowConstructorOptions,
  | 'titleBarStyle'
  | 'trafficLightPosition'
  | 'vibrancy'
  | 'visualEffectState'
  | 'backgroundColor'
  | 'transparent'
> {
  return platform === 'darwin'
    ? {
        titleBarStyle: 'hiddenInset',
        trafficLightPosition: { x: 14, y: 14 },
        vibrancy: 'under-window',
        visualEffectState: 'followWindow'
      }
    : { titleBarStyle: 'default', backgroundColor: OPAQUE_BACKGROUND }
}
