import { app, Menu, nativeImage, Tray, type BrowserWindow } from 'electron'
import type { DriftReceipt } from '@shared/drift'
import { PRODUCT } from '@shared/product'
import icon from '../../resources/icon.png?asset'

/**
 * Menu-bar / tray presence: the last receipt at a glance, open, compare again, quit.
 * Closing the window hides it here instead of quitting; Quit lives in this menu
 * and on the app menu.
 */
let tray: Tray | null = null
let last: DriftReceipt | null = null

export function createTray(show: () => BrowserWindow, compareAgain: () => void): Tray {
  const img = nativeImage.createFromPath(icon).resize({ width: 18, height: 18 })
  // macOS menu bar wants a monochrome "template" image; other platforms show colour.
  if (process.platform === 'darwin') img.setTemplateImage(true)
  tray = new Tray(img)
  tray.setToolTip(PRODUCT)
  const render = (): void => {
    const c = last?.counts
    const review = c ? c.changed + c.missing + c.extra + c.blank : 0
    const summary = last
      ? last.clean
        ? 'Last receipt: clean'
        : `Last receipt: ${review} to review · ${c!.missing} missing · ${c!.changed} changed`
      : 'No receipt yet'
    tray!.setContextMenu(
      Menu.buildFromTemplate([
        { label: `Open ${PRODUCT}`, click: () => void show() },
        { type: 'separator' },
        { label: summary, enabled: false },
        ...(last ? [{ label: 'Compare again', click: compareAgain }] : []),
        { type: 'separator' },
        { label: `Quit ${PRODUCT}`, click: () => app.quit() }
      ])
    )
  }
  render()
  tray.on('click', () => void show())
  ;(tray as Tray & { update: (r: DriftReceipt) => void }).update = (r) => {
    last = r
    render()
  }
  return tray
}

export function trayReceipt(r: DriftReceipt): void {
  ;(tray as (Tray & { update?: (r: DriftReceipt) => void }) | null)?.update?.(r)
}
