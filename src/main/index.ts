import { app, shell, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import log from 'electron-log/main'
import icon from '../../resources/icon.png?asset'
import { registerIpc } from './ipc'
import { Channels } from '@shared/channels'
import { e2eUserData } from './e2e'

// E2E runs get a throwaway userData; a no-op otherwise. Before the
// single-instance lock and the logger, which both key on userData.
e2eUserData()

log.initialize()
log.errorHandler.startCatching()

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    // Sit the traffic lights in their own strip above the sidebar header (see App.tsx mt-7).
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 14, y: 14 } } : {}),
    backgroundColor: '#08090a',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // Renderer is fully sandboxed. It talks to main only through the typed bridge in src/preload.
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('enter-full-screen', () =>
    mainWindow?.webContents.send(Channels.windowFullscreen, true)
  )
  mainWindow.on('leave-full-screen', () =>
    mainWindow?.webContents.send(Channels.windowFullscreen, false)
  )
  mainWindow.on('closed', () => (mainWindow = null))

  // Any window.open / target=_blank goes to the system browser, never a new Electron window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  // No in-app navigation away from our own document.
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault())

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// One instance: a second launch (Windows/Linux shortcut while parked in the tray) just
// surfaces the running one, instead of a duplicate tray and a second writer on the store.
if (!app.requestSingleInstanceLock()) app.quit()
app.on('second-instance', () => {
  if (mainWindow) {
    mainWindow.show()
    mainWindow.focus()
  }
})

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.theplumbr.drift')
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))
  registerIpc(() => mainWindow)
  createWindow()
  const show = (): BrowserWindow => {
    if (!mainWindow) createWindow()
    mainWindow!.show()
    mainWindow!.focus()
    return mainWindow!
  }
  // Dock click on macOS: the window may exist but be hidden in the tray.
  app.on('activate', () => void show())
})

// No tray: closing the last window quits on Windows and Linux, as users expect.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
