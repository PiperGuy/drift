import { app, dialog, ipcMain, safeStorage, type BrowserWindow } from 'electron'
import { join } from 'node:path'
import { Channels, CompareRequest, ScanRequest, ShapeRequest, type AppInfo } from '@shared/ipc'
import { grantRoot, scanWorkspace } from './workspace'
import { compareFiles, envShape, fingerprintKeyPersisted, loadFingerprintKey } from './env'
import { openStore } from './store'

/** Register every handler once. Inputs from the renderer are validated with zod first. */
export function registerIpc(getWindow: () => BrowserWindow | null): void {
  const dataPath = join(app.getPath('userData'), 'plumbr.db')
  const store = openStore(dataPath)
  loadFingerprintKey(
    () => store.getMeta('fingerprint_key_ref'),
    (sealed) => store.setMeta('fingerprint_key_ref', sealed),
    safeStorage
  )
  app.on('will-quit', () => store.close())

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
    store.rememberRoot(root)
    store.logEvent('grant', { root })
    return root
  })

  ipcMain.handle(Channels.workspaceRecent, () => {
    const root = store.lastRoot()
    if (root) grantRoot(root)
    return root
  })

  ipcMain.handle(Channels.historyList, () => store.listEvents())

  ipcMain.handle(Channels.dataForget, () => {
    store.forgetAll()
    store.logEvent('forget', {})
  })

  ipcMain.handle(Channels.workspaceScan, async (_e, raw: unknown) => {
    const { root } = ScanRequest.parse(raw)
    const scan = await scanWorkspace(root)
    store.touchRoot(root)
    store.logEvent('scan', { root }, { files: scan.files.length, projects: scan.projects.length })
    return scan
  })

  ipcMain.handle(Channels.envShape, (_e, raw: unknown) => {
    const { path } = ShapeRequest.parse(raw)
    return envShape(path)
  })

  ipcMain.handle(Channels.envCompare, async (_e, raw: unknown) => {
    const { left, right, ignore } = CompareRequest.parse(raw)
    const receipt = await compareFiles(left, right, ignore)
    const id = store.saveReceipt(receipt)
    store.logEvent(
      'compare',
      { left, right, receipt: id },
      { ...receipt.counts, clean: receipt.clean }
    )
    return receipt
  })

  ipcMain.handle(Channels.appInfo, (): AppInfo => ({
    version: app.getVersion(),
    platform: process.platform,
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
    dataPath,
    keyPersisted: fingerprintKeyPersisted(),
    mcp: {
      command: process.execPath,
      args: [join(__dirname, 'mcp.js'), '--db', dataPath],
      env: { ELECTRON_RUN_AS_NODE: '1' }
    }
  }))
}
