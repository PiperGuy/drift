import { contextBridge, ipcRenderer } from 'electron'
import { Channels, type PlumbrApi } from '@shared/channels'

/** The only surface the renderer gets. Keep it small and typed. */
const plumbr: PlumbrApi = {
  pickWorkspace: () => ipcRenderer.invoke(Channels.workspacePick),
  scanWorkspace: (req) => ipcRenderer.invoke(Channels.workspaceScan, req),
  envShape: (req) => ipcRenderer.invoke(Channels.envShape, req),
  compareEnv: (req) => ipcRenderer.invoke(Channels.envCompare, req),
  appInfo: () => ipcRenderer.invoke(Channels.appInfo),
  recentWorkspaces: () => ipcRenderer.invoke(Channels.workspaceRecent),
  addSshRoot: (req) => ipcRenderer.invoke(Channels.workspaceAddSsh, req),
  removeRoot: (path) => ipcRenderer.invoke(Channels.workspaceRemove, path),
  listWorkspaces: () => ipcRenderer.invoke(Channels.wsList),
  createWorkspace: (name) => ipcRenderer.invoke(Channels.wsCreate, name),
  renameWorkspace: (req) => ipcRenderer.invoke(Channels.wsRename, req),
  deleteWorkspace: (id) => ipcRenderer.invoke(Channels.wsDelete, id),
  switchWorkspace: (id) => ipcRenderer.invoke(Channels.wsSwitch, id),
  listHistory: () => ipcRenderer.invoke(Channels.historyList),
  forgetData: () => ipcRenderer.invoke(Channels.dataForget),
  clearCache: () => ipcRenderer.invoke(Channels.dataClear),
  getSettings: () => ipcRenderer.invoke(Channels.settingsGet),
  setSettings: (patch) => ipcRenderer.invoke(Channels.settingsSet, patch),
  getLicense: () => ipcRenderer.invoke(Channels.licenseGet),
  activateLicense: (key) => ipcRenderer.invoke(Channels.licenseActivate, key),
  checkUpdates: () => ipcRenderer.invoke(Channels.updateCheck),
  mcpClients: () => ipcRenderer.invoke(Channels.mcpClients),
  mcpInstall: (id) => ipcRenderer.invoke(Channels.mcpInstall, id),
  mcpUninstall: (id) => ipcRenderer.invoke(Channels.mcpUninstall, id),
  revealValue: (req) => ipcRenderer.invoke(Channels.envReveal, req),
  revealAll: (req) => ipcRenderer.invoke(Channels.envRevealAll, req),
  onUpdate: (cb) => {
    const h = (_e: Electron.IpcRendererEvent, ev: Parameters<typeof cb>[0]): void => cb(ev)
    ipcRenderer.on(Channels.updateEvent, h)
    return () => ipcRenderer.removeListener(Channels.updateEvent, h)
  },
  installUpdate: () => ipcRenderer.invoke(Channels.updateInstall),
  applyPlan: (req) => ipcRenderer.invoke(Channels.envApply, req),
  listSnapshots: () => ipcRenderer.invoke(Channels.historySnapshots),
  rollback: (id) => ipcRenderer.invoke(Channels.historyRollback, id),
  viewEnv: (req) => ipcRenderer.invoke(Channels.envView, req),
  formatEnv: (req) => ipcRenderer.invoke(Channels.envFormat, req),
  setValues: (req) => ipcRenderer.invoke(Channels.envSet, req),
  sshHosts: () => ipcRenderer.invoke(Channels.sshHosts),
  onFullscreen: (cb) => {
    const h = (_e: Electron.IpcRendererEvent, on: boolean): void => cb(on)
    ipcRenderer.on(Channels.windowFullscreen, h)
    return () => ipcRenderer.removeListener(Channels.windowFullscreen, h)
  },
  onTrayCompare: (cb) => {
    ipcRenderer.on(Channels.trayCompare, cb)
    return () => ipcRenderer.removeListener(Channels.trayCompare, cb)
  }
}

contextBridge.exposeInMainWorld('plumbr', plumbr)
