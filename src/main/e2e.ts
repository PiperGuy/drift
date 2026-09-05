import { app } from 'electron'

/**
 * E2E-only bootstrap for the Playwright desktop tests (see e2e/ and docs/e2e.md).
 *
 * Active ONLY when the app is NOT packaged AND the runner set DRIFT_E2E=1, so a
 * shipped build can never enter this path. When active it does exactly two
 * narrow things, both fixed at process start by the test runner:
 *   1. point userData at a throwaway temp directory, and
 *   2. remember ONE fixture workspace root, standing in for the OS folder
 *      picker (which cannot be driven headlessly).
 * It exposes no IPC channel, reveals no values, and grants nothing at runtime
 * beyond what a user could grant themselves through the picker.
 */
const active = (): boolean => !app.isPackaged && process.env['DRIFT_E2E'] === '1'

/** Must run before the single-instance lock: the lock is keyed on userData. */
export function e2eUserData(): void {
  const dir = process.env['DRIFT_E2E_USERDATA']
  if (active() && dir) app.setPath('userData', dir)
}

/** The one fixture root to remember at startup, or null outside E2E. */
export function e2eFixtureRoot(): string | null {
  const root = process.env['DRIFT_E2E_GRANT_ROOT']
  return active() && root ? root : null
}
