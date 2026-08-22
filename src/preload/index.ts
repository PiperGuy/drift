import { contextBridge, ipcRenderer } from 'electron'
import { Channels, type PlumbrApi } from '@shared/channels'

/** The only surface the renderer gets. Keep it small and typed. */
const plumbr: PlumbrApi = {
  pickWorkspace: () => ipcRenderer.invoke(Channels.workspacePick),
  scanWorkspace: (req) => ipcRenderer.invoke(Channels.workspaceScan, req),
  envShape: (req) => ipcRenderer.invoke(Channels.envShape, req),
  compareEnv: (req) => ipcRenderer.invoke(Channels.envCompare, req),
  appInfo: () => ipcRenderer.invoke(Channels.appInfo),
  recentWorkspace: () => ipcRenderer.invoke(Channels.workspaceRecent),
  listHistory: () => ipcRenderer.invoke(Channels.historyList),
  forgetData: () => ipcRenderer.invoke(Channels.dataForget)
}

contextBridge.exposeInMainWorld('plumbr', plumbr)
