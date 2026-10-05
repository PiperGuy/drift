import { app, dialog, ipcMain, safeStorage, type BrowserWindow } from 'electron'
import { join } from 'node:path'
import { copyFileSync } from 'node:fs'
import {
  Channels,
  CompareRequest,
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
import { grantRoot, revokeRoot, revokeRoots, scanWorkspace } from './workspace'
import {
  baseRef,
  checkDockerRoot,
  checkRemoteRoot,
  dockerContainers,
  dockerRef,
  parseRef,
  readText,
  sshConfigHosts,
  sshRef
} from './fs'
import type { RootInfo, SourceRoot } from '@shared/channels'
import { compareGuarded, envShape, fingerprintKeyPersisted, loadFingerprintKey } from './env'
import { compareProjects, ensureSourceRoot, toRoot } from './compare'
import { startBridge } from './bridge'
import { openStore } from './store'
import { install, statusAll, uninstall } from './mcp-clients'
import { osAuth } from './auth'
import { revealAllValues, revealValue } from './env'
import {
  ApplyRequestSchema,
  FormatRequestSchema,
  RevealRequestSchema,
  SetRequestSchema,
  SshRootRequest,
  RootPath,
  WorkspaceId,
  WorkspaceName,
  WorkspaceRename,
  SnapshotId,
  ViewRequestSchema
} from '@shared/ipc'
import { applyPlan, formatFile, rollback, setValues } from './write'
import {
  connectVault,
  discoverVault,
  dropVaultTokens,
  forgetVaultConnection,
  registerVault,
  vaultHistory,
  vaultRestore,
  vaultShapeAt
} from './providers/vault'
import {
  discoverList,
  discoverMount,
  discoverVersions,
  endDiscovery
} from './providers/vault/discover'
import {
  DockerHost,
  DockerSourceSpecSchema,
  EcsDiscoverSchema,
  ProjectCompareRequestSchema,
  ProviderConnectSpecSchema,
  VaultDiscoverListSchema,
  VaultDiscoverMountSchema,
  VaultDiscoverSpecSchema,
  VaultDiscoverVersionsSchema,
  VaultRestoreSchema,
  VaultSessionSchema,
  VaultShapeAtSchema,
  VaultSourceSpecSchema
} from '@shared/ipc'
import { connectProvider, registerProviders } from './providers'
import { dropSecrets, forgetProviderConnection } from './providers/connection'
import { awsProfiles } from './providers/aws/creds'
import { discoverEcs } from './providers/aws/ecs'
import { viewEnv } from '@shared/env-lint'
import { PRODUCT } from '@shared/product'
import { envKind } from '@shared/env-file'
import { assertGranted } from './workspace'
import { e2eFixtureRoot } from './e2e'

/** Register every handler once. Inputs from the renderer are validated with zod first. */
export function registerIpc(getWindow: () => BrowserWindow | null): void {
  const dataPath = join(app.getPath('userData'), 'plumbr.db')
  const store = openStore(dataPath)
  // E2E only (never in a packaged build): remember the fixture root the test
  // runner would otherwise have to grant through the OS folder picker.
  const fixtureRoot = e2eFixtureRoot()
  if (fixtureRoot) store.rememberRoot(fixtureRoot)
  loadFingerprintKey(
    () => store.getMeta('fingerprint_key_ref'),
    (sealed) => store.setMeta('fingerprint_key_ref', sealed),
    safeStorage
  )
  app.on('will-quit', () => store.close())
  // Vault adapter: registers the vault:// backend for fs.ts and holds session tokens.
  registerVault(store)
  // Providers (Vercel, GitHub, Railway, Render, Dokploy, Coolify, AWS): same seam.
  registerProviders(store)
  // Local bridge for the MCP server: sources, cross-source compare, plans and applies are
  // answered here, with the credentials this process holds. Socket and token die with the app.
  const bridge = startBridge(store, app.getPath('userData'), {
    // The human in the loop for agent syncs: a native dialog, on the app window, that names
    // what will be written where. Only the "Write" button resolves true; Cancel, Escape and
    // closing the dialog all fail closed.
    approve: async (p) => {
      const win = getWindow()
      if (win) {
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
      }
      const n = p.keys.length
      const opts: Electron.MessageBoxOptions = {
        type: 'warning',
        title: `Agent sync request`,
        message: `A coding agent asks ${PRODUCT} to write ${n} key${n === 1 ? '' : 's'} from ${p.source.label} to ${p.target.label}`,
        detail: `Source: ${p.source.label} · ${p.source.path}\nTarget: ${p.target.label} · ${p.target.path}\n\nKeys:\n${p.keys.map((k) => `  ${k}`).join('\n')}\n\n${p.consequence}`,
        buttons: ['Cancel', `Write ${n} key${n === 1 ? '' : 's'}`],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      }
      const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
      return r.response === 1
    }
  }).catch((e) => {
    log.warn('MCP bridge not started', e)
    return null
  })
  app.on('will-quit', () => void bridge.then((b) => b?.close()))

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
  const settings = (): Settings => ({
    mcpEnabled: store.getMeta('mcp_enabled') !== '0',
    onboarded: store.getMeta('onboarded') === '1'
  })

  ipcMain.handle(Channels.settingsGet, settings)
  ipcMain.handle(Channels.settingsSet, (_e, raw: unknown) => {
    const patch = SettingsPatch.parse(raw)
    if (patch.mcpEnabled !== undefined) store.setMeta('mcp_enabled', patch.mcpEnabled ? '1' : '0')
    if (patch.onboarded !== undefined) store.setMeta('onboarded', patch.onboarded ? '1' : '0')
    return settings()
  })

  ipcMain.handle(Channels.updateCheck, async (): Promise<UpdateResult> => {
    if (!app.isPackaged)
      return { status: 'error', message: 'Updates only work in a packaged build.' }
    try {
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
    return toRoot(store, root, null)
  })

  ipcMain.handle(Channels.sshHosts, () => sshConfigHosts())

  ipcMain.handle(Channels.workspaceAddSsh, async (_e, raw: unknown) => {
    const { host, path } = SshRootRequest.parse(raw)
    await checkRemoteRoot(host, path)
    const root = sshRef(host, path.replace(/\/+$/, '') || '/')
    grantRoot(root)
    store.rememberRoot(root)
    store.logEvent('grant', { root })
    return toRoot(store, root, null)
  })

  ipcMain.handle(Channels.workspaceRemove, (_e, raw: unknown) => {
    const path = RootPath.parse(raw)
    revokeRoot(path)
    store.forgetRoot(path)
    const kind = parseRef(path).kind
    if (kind === 'vault' || kind === 'provider') {
      // Drop the connection row and the in-memory token with the root.
      forgetVaultConnection(store, path)
      forgetProviderConnection(store, path)
      store.logEvent('connection', { action: 'remove', root: path })
    }
    store.logEvent('revoke', { root: path })
  })

  ipcMain.handle(Channels.workspaceAddDocker, async (_e, raw: unknown) => {
    const { host, container, path } = DockerSourceSpecSchema.parse(raw)
    await checkDockerRoot(host ?? null, container, path)
    const root = dockerRef(host ?? null, container, path.replace(/\/+$/, '') || '/')
    grantRoot(root)
    store.rememberRoot(root)
    store.logEvent('grant', { root })
    return toRoot(store, root, null)
  })
  ipcMain.handle(Channels.dockerContainers, (_e, raw: unknown) =>
    dockerContainers(DockerHost.parse(raw) ?? null)
  )
  ipcMain.handle(Channels.awsProfiles, () => awsProfiles())
  ipcMain.handle(Channels.ecsDiscover, (_e, raw: unknown) => {
    return discoverEcs(EcsDiscoverSchema.parse(raw))
  })

  ipcMain.handle(Channels.providerConnect, async (_e, raw: unknown) => {
    const spec = ProviderConnectSpecSchema.parse(raw)
    const result = await connectProvider(store, spec)
    grantRoot(result.root.path)
    store.rememberRoot(result.root.path, result.root.label)
    // Redacted: provider and root only — never a token, profile credential or value.
    store.logEvent(
      'connection',
      { action: 'add', root: result.root.path },
      { provider: spec.provider, warnings: result.warnings.length }
    )
    return result
  })

  ipcMain.handle(Channels.vaultConnect, async (_e, raw: unknown) => {
    const spec = VaultSourceSpecSchema.parse(raw)
    const result = await connectVault(store, spec)
    grantRoot(result.root.path)
    store.rememberRoot(result.root.path, result.root.label)
    // Redacted: host and mount/path only — never the namespace token or credentials.
    store.logEvent(
      'connection',
      { action: 'add', root: result.root.path },
      { kind: result.preflight.kind, warnings: result.preflight.warnings.length }
    )
    return result
  })

  // Browse Vault: metadata only, nothing granted or persisted until a pick is connected above.
  ipcMain.handle(Channels.vaultDiscover, (_e, raw: unknown) =>
    discoverVault(VaultDiscoverSpecSchema.parse(raw))
  )
  ipcMain.handle(Channels.vaultDiscoverMount, (_e, raw: unknown) => {
    const { session, path } = VaultDiscoverMountSchema.parse(raw)
    return discoverMount(session, path)
  })
  ipcMain.handle(Channels.vaultDiscoverList, (_e, raw: unknown) => {
    const { session, mount, folder } = VaultDiscoverListSchema.parse(raw)
    return discoverList(session, mount, folder)
  })
  ipcMain.handle(Channels.vaultDiscoverVersions, (_e, raw: unknown) => {
    const { session, mount, path } = VaultDiscoverVersionsSchema.parse(raw)
    return discoverVersions(session, mount, path)
  })
  ipcMain.handle(Channels.vaultDiscoverEnd, (_e, raw: unknown) => {
    endDiscovery(VaultSessionSchema.parse(raw))
  })

  ipcMain.handle(Channels.vaultHistory, (_e, raw: unknown) => {
    const path = RootPath.parse(raw)
    assertGranted(path)
    return vaultHistory(store, path)
  })

  ipcMain.handle(Channels.vaultShapeAt, (_e, raw: unknown) => {
    const { path, version } = VaultShapeAtSchema.parse(raw)
    assertGranted(path)
    return vaultShapeAt(store, path, version)
  })

  ipcMain.handle(Channels.vaultRestore, async (_e, raw: unknown) => {
    const { path, version, expectedVersion } = VaultRestoreSchema.parse(raw)
    assertGranted(path)
    const r = await vaultRestore(store, path, version, expectedVersion)
    store.logEvent(
      'rollback',
      { path, snapshot: r.snapshot },
      { vault: `v${version} -> v${r.version?.next}` }
    )
    return r
  })

  const grantActive = (): RootInfo[] => {
    revokeRoots()
    const roots = store.listRoots()
    for (const r of roots) grantRoot(r.path)
    return roots.map((r) => toRoot(store, r.path, r.label))
  }
  ipcMain.handle(Channels.wsList, () => {
    return { active: store.activeWorkspace(), all: store.listWorkspaces() }
  })
  ipcMain.handle(Channels.wsCreate, (_e, raw: unknown) => {
    const name = WorkspaceName.parse(raw)
    if (store.listWorkspaces().some((w) => w.name.toLowerCase() === name.toLowerCase()))
      throw new Error(`A workspace named ${name} already exists`)
    const w = store.createWorkspace(name)
    store.logEvent('workspace', { action: 'create', name })
    return w
  })
  ipcMain.handle(Channels.wsRename, (_e, raw: unknown) => {
    const { id, name } = WorkspaceRename.parse(raw)
    if (
      store.listWorkspaces().some((w) => w.id !== id && w.name.toLowerCase() === name.toLowerCase())
    )
      throw new Error(`A workspace named ${name} already exists`)
    store.renameWorkspace(id, name)
  })
  ipcMain.handle(Channels.wsDelete, (_e, raw: unknown) => {
    const id = WorkspaceId.parse(raw)
    const all = store.listWorkspaces()
    if (all.length <= 1) throw new Error('Keep at least one workspace')
    const name = all.find((w) => w.id === id)?.name
    const dropped = store.deleteWorkspace(id)
    dropVaultTokens(dropped)
    dropSecrets(dropped)
    if (store.activeWorkspace() === id) store.setActiveWorkspace(all.find((w) => w.id !== id)!.id)
    store.logEvent('workspace', { action: 'delete', name })
    grantActive()
  })
  ipcMain.handle(Channels.wsSwitch, (_e, raw: unknown) => {
    const id = WorkspaceId.parse(raw)
    if (!store.listWorkspaces().some((w) => w.id === id)) throw new Error('Unknown workspace')
    store.setActiveWorkspace(id)
    return grantActive()
  })

  ipcMain.handle(Channels.workspaceRecent, () => {
    return grantActive()
  })
  // Every remembered root of every source, for the cross-source picker. Metadata only; nothing is granted here.
  ipcMain.handle(Channels.rootsAll, (): SourceRoot[] => {
    const names = new Map(store.listWorkspaces().map((w) => [w.id, w.name]))
    return store.listAllRoots().map((r) => ({
      ...toRoot(store, r.path, r.label),
      workspace: r.workspaceId,
      workspaceName: names.get(r.workspaceId) ?? ''
    }))
  })
  ipcMain.handle(Channels.projectCompare, (_e, raw: unknown) => {
    return compareProjects(store, ProjectCompareRequestSchema.parse(raw))
  })

  ipcMain.handle(Channels.historyList, () => {
    return store.listEvents()
  })

  ipcMain.handle(Channels.dataClear, () => {
    store.clearCache()
    store.logEvent('clear', {})
  })

  ipcMain.handle(Channels.dataForget, () => {
    revokeRoots()
    const dropped = store.forgetAll()
    dropVaultTokens(dropped)
    endDiscovery()
    dropSecrets(dropped)
    store.logEvent('forget', {})
  })

  ipcMain.handle(Channels.workspaceScan, async (_e, raw: unknown) => {
    const { root } = ScanRequest.parse(raw)
    // A remembered root of another source is granted for the session (cross-source picker).
    ensureSourceRoot(store, root)
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
    assertGranted(left)
    assertGranted(right)
    const { receipt } = await compareGuarded(store, left, right, ignore)
    store.logEvent(
      'compare',
      { left, right, receipt: receipt.id },
      { ...receipt.counts, clean: receipt.clean }
    )
    return receipt
  })

  let authed: Awaited<ReturnType<typeof osAuth>> | null = null
  ipcMain.handle(Channels.envReveal, async (_e, raw: unknown) => {
    const { path, key } = RevealRequestSchema.parse(raw)
    // One OS prompt per app session: the first reveal authenticates, later ones reuse it.
    // Every reveal is still logged by key name.
    const method = authed ?? (authed = await osAuth('reveal environment values', getWindow()))
    const value = await revealValue(path, key)
    store.logEvent('reveal', { path, key }, { method })
    return { value, method }
  })

  ipcMain.handle(Channels.envApply, async (_e, raw: unknown) => {
    const req = ApplyRequestSchema.parse(raw)
    const result = await applyPlan(store, req)
    store.logEvent(
      'apply',
      { left: req.left, right: req.right, snapshot: result.snapshot, receipt: req.receipt },
      {
        written: result.written,
        skipped: result.skipped,
        ...(result.verified !== undefined ? { verified: result.verified } : {}),
        ...(result.version ? { version: result.version } : {})
      }
    )
    return result
  })
  ipcMain.handle(Channels.envView, async (_e, raw: unknown) => {
    const { path } = ViewRequestSchema.parse(raw)
    assertGranted(path)
    const text = await readText(path)
    return viewEnv(text, { example: envKind(baseRef(path)) === 'example' })
  })
  ipcMain.handle(Channels.envFormat, async (_e, raw: unknown) => {
    const { path, expectedMtime } = FormatRequestSchema.parse(raw)
    const r = await formatFile(store, path, expectedMtime)
    if (r.changed) store.logEvent('format', { path, snapshot: r.snapshot }, { changed: r.changed })
    return r
  })
  ipcMain.handle(Channels.envSet, async (_e, raw: unknown) => {
    const req = SetRequestSchema.parse(raw)
    const r = await setValues(store, req)
    store.logEvent('edit', { path: req.path, snapshot: r.snapshot }, { written: r.written })
    return r
  })
  ipcMain.handle(Channels.historySnapshots, () => {
    return store.listSnapshots()
  })
  ipcMain.handle(Channels.historyRollback, async (_e, raw: unknown) => {
    const id = SnapshotId.parse(raw)
    await rollback(store, id)
    store.logEvent('rollback', { snapshot: id, path: store.snapshotBlob(id)?.path })
  })

  ipcMain.handle(Channels.envRevealAll, async (_e, raw: unknown) => {
    const { path } = ViewRequestSchema.parse(raw)
    const method = authed ?? (authed = await osAuth('reveal environment values', getWindow()))
    const values = await revealAllValues(path)
    store.logEvent('reveal', { path, key: '*' }, { method, keys: Object.keys(values).length })
    return { values, method }
  })

  // Background update: check shortly after launch, download silently, tell the renderer.
  ipcMain.handle(Channels.updateInstall, () => autoUpdater.quitAndInstall())
  if (app.isPackaged) {
    const send = (ev: unknown): void => getWindow()?.webContents.send(Channels.updateEvent, ev)
    autoUpdater.autoDownload = true
    autoUpdater.on('update-available', (i) => send({ kind: 'available', version: i.version }))
    autoUpdater.on('update-downloaded', (i) => send({ kind: 'downloaded', version: i.version }))
    autoUpdater.on('error', (e) => send({ kind: 'error', message: e.message }))
    setTimeout(() => void autoUpdater.checkForUpdates().catch(() => {}), 10_000)
  }

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
