import { test, expect } from './fixtures'

/**
 * Fresh app boot: first-run journey appears, and the renderer's security
 * boundary holds — sandboxed, context-isolated, only the typed bridge exposed.
 */
test.describe('fresh boot', () => {
  test.use({ grantWorkspace: false })

  test('shows onboarding and exposes only the typed bridge', async ({
    electronApp,
    window
  }): Promise<void> => {
    await expect(window.getByText('Welcome to Drift')).toBeVisible()

    // Renderer security surface: no node, no raw ipc, only window.plumbr.
    const surface = await window.evaluate(() => {
      const w = globalThis as unknown as Record<string, unknown>
      const plumbr = w.plumbr as Record<string, unknown> | undefined
      return {
        hasRequire: 'require' in w && w.require !== undefined,
        hasProcess: 'process' in w && w.process !== undefined,
        hasIpcRenderer: 'ipcRenderer' in w && w.ipcRenderer !== undefined,
        hasElectron: 'electron' in w && w.electron !== undefined,
        bridge: plumbr ? Object.keys(plumbr).length : 0,
        bridgeIsFunctions: plumbr
          ? Object.values(plumbr).every((v) => typeof v === 'function')
          : false
      }
    })
    expect(surface.hasRequire).toBe(false)
    expect(surface.hasProcess).toBe(false)
    expect(surface.hasIpcRenderer).toBe(false)
    expect(surface.hasElectron).toBe(false)
    expect(surface.bridge).toBeGreaterThan(10)
    expect(surface.bridgeIsFunctions).toBe(true)

    // Main-process web preferences: the window really is sandboxed and isolated.
    const prefs = await electronApp.evaluate(({ BrowserWindow }) => {
      // getLastWebPreferences exists at runtime but is missing from the types.
      const wc = BrowserWindow.getAllWindows()[0].webContents as unknown as {
        getLastWebPreferences?: () => {
          sandbox?: boolean
          contextIsolation?: boolean
          nodeIntegration?: boolean
        }
      }
      const wp = wc.getLastWebPreferences?.()
      return {
        sandbox: wp?.sandbox,
        contextIsolation: wp?.contextIsolation,
        node: wp?.nodeIntegration
      }
    })
    expect(prefs.sandbox).toBe(true)
    expect(prefs.contextIsolation).toBe(true)
    expect(prefs.node).toBe(false)

    // No workspace was granted: a scan of an arbitrary path must be refused.
    const refused = await window.evaluate(async () => {
      try {
        await (
          globalThis as unknown as {
            plumbr: { scanWorkspace: (r: { root: string }) => Promise<unknown> }
          }
        ).plumbr.scanWorkspace({ root: '/etc' })
        return 'allowed'
      } catch (e) {
        return String(e)
      }
    })
    expect(refused).toMatch(/not a source in this app|outside every granted workspace root/)
  })
})
