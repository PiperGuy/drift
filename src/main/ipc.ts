import { app, dialog, ipcMain, safeStorage, type BrowserWindow } from 'electron'
import { join } from 'node:path'
import { copyFileSync } from 'node:fs'
import {
  Channels,
  CompareRequest,
  LicenseKey,
  McpClientIdSchema,
  ScanRequest,
  SettingsPatch,
  ShapeRequest,
  type AppInfo,
  type McpLaunch,
  type Settings,
  type UpdateResult
} from '@shared/ipc'
import { autoUpdater } from 'electron-updater'
import log from 'electron-log/main'
import { grantRoot, revokeRoots, scanWorkspace } from './workspace'
import { compareFiles, envShape, fingerprintKeyPersisted, loadFingerprintKey } from './env'
import { openStore } from './store'
import { activate, assertUnlocked, currentLicense } from './license'
import { install, statusAll, uninstall } from './mcp-clients'

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

  // The server script is copied next to the database on every launch, so the path
  // clients store survives app updates and temporary AppImage mounts. The command is
  // the AppImage itself on Linux (stable), the app binary elsewhere.
  const mcpScript = join(app.getPath('userData'), 'mcp.js')
  try {
    copyFileSync(join(__dirname, 'mcp.js'), mcpScript)
  } catch (e) {
    log.warn('mcp.js not copied', e)
  }
  const launch: McpLaunch = {
    command: process.env['APPIMAGE'] ?? process.execPath,
    args: [mcpScript, '--db', dataPath],
    env: { ELECTRON_RUN_AS_NODE: '1' }
  }
  // out/main → repo root in dev; app.asar → app.asar.unpacked (see asarUnpack) when packaged.
  const skillDir = join(__dirname, '..', '..', 'resources', 'skills', 'drift').replace(
    'app.asar',
    'app.asar.unpacked'
  )
  const settings = (): Settings => ({ mcpEnabled: store.getMeta('mcp_enabled') !== '0' })

  ipcMain.handle(Channels.settingsGet, settings)
  ipcMain.handle(Channels.settingsSet, (_e, raw: unknown) => {
    const patch = SettingsPatch.parse(raw)
    if (patch.mcpEnabled !== undefined) store.setMeta('mcp_enabled', patch.mcpEnabled ? '1' : '0')
    return settings()
  })

  ipcMain.handle(Channels.licenseGet, () => currentLicense(store))
  ipcMain.handle(Channels.licenseActivate, (_e, raw: unknown) => {
    const state = activate(store, LicenseKey.parse(raw))
    store.logEvent('license', { name: state.state === 'licensed' ? state.name : '' })
    return state
  })

  ipcMain.handle(Channels.updateCheck, async (): Promise<UpdateResult> => {
    if (!app.isPackaged)
      return { status: 'error', message: 'Updates only work in a packaged build.' }
    try {
      autoUpdater.autoDownload = false
      const r = await autoUpdater.checkForUpdates()
      const v = r?.updateInfo.version
      return v && v !== app.getVersion()
        ? { status: 'available', version: v }
        : { status: 'current', version: app.getVersion() }
    } catch (e) {
      return { status: 'error', message: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle(Channels.mcpClients, () => statusAll())
  ipcMain.handle(Channels.mcpInstall, async (_e, raw: unknown) => {
    assertUnlocked(store)
    const id = McpClientIdSchema.parse(raw)
    await install(id, launch, skillDir)
    store.logEvent('mcp_install', { client: id })
    return statusAll()
  })
  ipcMain.handle(Channels.mcpUninstall, async (_e, raw: unknown) => {
    const id = McpClientIdSchema.parse(raw)
    await uninstall(id)
    store.logEvent('mcp_uninstall', { client: id })
    return statusAll()
  })

  ipcMain.handle(Channels.workspacePick, async () => {
    assertUnlocked(store)
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
    assertUnlocked(store)
    const root = store.lastRoot()
    if (root) grantRoot(root)
    return root
  })

  ipcMain.handle(Channels.historyList, () => {
    assertUnlocked(store)
    return store.listEvents()
  })

  ipcMain.handle(Channels.dataClear, () => {
    assertUnlocked(store)
    store.clearCache()
    store.logEvent('clear', {})
  })

  ipcMain.handle(Channels.dataForget, () => {
    assertUnlocked(store)
    revokeRoots()
    store.forgetAll()
    store.logEvent('forget', {})
  })

  ipcMain.handle(Channels.workspaceScan, async (_e, raw: unknown) => {
    assertUnlocked(store)
    const { root } = ScanRequest.parse(raw)
    const scan = await scanWorkspace(root)
    store.touchRoot(root)
    store.logEvent('scan', { root }, { files: scan.files.length, projects: scan.projects.length })
    return scan
  })

  ipcMain.handle(Channels.envShape, (_e, raw: unknown) => {
    assertUnlocked(store)
    const { path } = ShapeRequest.parse(raw)
    return envShape(path)
  })

  ipcMain.handle(Channels.envCompare, async (_e, raw: unknown) => {
    assertUnlocked(store)
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
    mcp: launch
  }))
}
