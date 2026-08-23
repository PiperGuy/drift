import { app, dialog, systemPreferences, type BrowserWindow } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * Ask the OS to confirm the person at the keyboard before a value is shown.
 *  - macOS: Touch ID (or the password sheet Apple falls back to).
 *  - Linux: a polkit prompt via `pkexec`, when present.
 *  - Windows, or when the above are unavailable: a native confirm dialog.
 *    Electron has no Windows Hello API; this is stated in the UI.
 * Resolves with the method used; rejects when the user cancels or auth fails.
 */
export type AuthMethod = 'touchid' | 'polkit' | 'dialog'

export async function osAuth(reason: string, win: BrowserWindow | null): Promise<AuthMethod> {
  if (process.platform === 'darwin' && systemPreferences.canPromptTouchID()) {
    await systemPreferences.promptTouchID(reason) // throws on cancel/failure
    return 'touchid'
  }
  if (process.platform === 'linux') {
    try {
      await run('pkexec', ['/bin/true']) // the polkit agent prompts; exit 126 = dismissed
      return 'polkit'
    } catch (e) {
      const err = e as NodeJS.ErrnoException & { stderr?: string }
      const noAgent =
        err.code === 'ENOENT' || /authentication agent|not registered/i.test(err.stderr ?? '')
      // No polkit, or no agent to show a prompt (headless, SSH): fall through to the dialog.
      if (!noAgent) throw new Error('Authentication cancelled')
    }
  }
  const opts: Electron.MessageBoxOptions = {
    type: 'warning',
    title: app.getName(),
    message: `${app.getName()} wants to ${reason}.`,
    detail:
      'Values are shown on screen only, never logged or sent. You will not be asked again this session.',
    buttons: ['Reveal', 'Cancel'],
    defaultId: 1,
    cancelId: 1
  }
  const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
  if (r.response !== 0) throw new Error('Authentication cancelled')
  return 'dialog'
}
