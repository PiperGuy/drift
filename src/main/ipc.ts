import { app, dialog, ipcMain, type BrowserWindow } from 'electron'
import { Channels, CompareRequest, ScanRequest, ShapeRequest, type AppInfo } from '@shared/ipc'
import { grantRoot, scanWorkspace } from './workspace'
import { compareFiles, envShape } from './env'

/** Register every handler once. Inputs from the renderer are validated with zod first. */
export function registerIpc(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle(Channels.workspacePick, async () => {
    const win = getWindow()
    const opts: Electron.OpenDialogOptions = {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Grant a workspace root'
    }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (res.canceled || res.filePaths.length === 0) return null
    const root = res.filePaths[0]
    grantRoot(root)
    return root
  })

  ipcMain.handle(Channels.workspaceScan, (_e, raw: unknown) => {
    const { root } = ScanRequest.parse(raw)
    return scanWorkspace(root)
  })

  ipcMain.handle(Channels.envShape, (_e, raw: unknown) => {
    const { path } = ShapeRequest.parse(raw)
    return envShape(path)
  })

  ipcMain.handle(Channels.envCompare, (_e, raw: unknown) => {
    const { left, right, ignore } = CompareRequest.parse(raw)
    return compareFiles(left, right, ignore)
  })

  ipcMain.handle(Channels.appInfo, (): AppInfo => ({
    version: app.getVersion(),
    platform: process.platform,
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome
  }))
}
