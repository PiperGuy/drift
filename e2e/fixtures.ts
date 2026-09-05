import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  test as base,
  expect,
  _electron,
  type ElectronApplication,
  type Page
} from '@playwright/test'

/**
 * Every value below is a deliberately fake fixture secret. They exist to prove
 * the app never renders raw values; no real credential ever appears in e2e.
 */
export const FAKE = {
  sharedA: 'fixture-shared-token-a1-not-a-real-secret',
  sharedB: 'fixture-shared-token-b2-not-a-real-secret',
  newFlag: 'fixture-new-flag-value',
  apiUrl: 'https://drift-e2e.invalid/api',
  extra: 'fixture-extra-only-keep-me'
}

export const ENV_SOURCE = [
  `API_URL=${FAKE.apiUrl}`,
  `SHARED_TOKEN=${FAKE.sharedA}`,
  `NEW_FLAG=${FAKE.newFlag}`,
  'BLANK_KEY=',
  'NODE_ENV=development',
  ''
].join('\n')

export const ENV_TARGET = [
  `API_URL=${FAKE.apiUrl}`,
  `SHARED_TOKEN=${FAKE.sharedB}`,
  `EXTRA_ONLY=${FAKE.extra}`,
  'BLANK_KEY=',
  'NODE_ENV=production',
  ''
].join('\n')

type AppFixtures = {
  /** Absolute path of the fixture project (the single granted workspace root). */
  workspace: string
  /** Set false for the fresh-boot test: the app starts with no granted root. */
  grantWorkspace: boolean
  electronApp: ElectronApplication
  window: Page
}

export const test = base.extend<AppFixtures>({
  grantWorkspace: [true, { option: true }],

  // A throwaway project with several .env* files inside a git repo marker,
  // recreated per test so no state leaks between tests.
  workspace: async ({}, use) => {
    const dir = mkdtempSync(join(tmpdir(), 'drift-e2e-ws-'))
    const project = join(dir, 'app')
    mkdirSync(join(project, '.git'), { recursive: true })
    writeFileSync(join(project, '.env'), ENV_SOURCE)
    writeFileSync(join(project, '.env.production'), ENV_TARGET)
    writeFileSync(join(project, '.env.local'), `LOCAL_ONLY=fixture-local-only\n`)
    await use(dir)
    rmSync(dir, { recursive: true, force: true })
  },

  electronApp: async ({ workspace, grantWorkspace }, use) => {
    const userData = mkdtempSync(join(tmpdir(), 'drift-e2e-data-'))
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      DRIFT_E2E: '1',
      DRIFT_E2E_USERDATA: userData,
      ...(grantWorkspace ? { DRIFT_E2E_GRANT_ROOT: workspace } : {})
    }
    // Never inherit node-mode into the app; Electron must boot as a browser.
    delete env.ELECTRON_RUN_AS_NODE
    const app = await _electron.launch({
      args: [
        join(__dirname, '..', 'out', 'main', 'index.js'),
        // CI runners lack the SUID/userns Chromium sandbox; the renderer keeps
        // sandbox:true + contextIsolation from the app's own webPreferences.
        '--no-sandbox',
        '--disable-gpu'
      ],
      env
    })
    await use(app)
    await app.close().catch(() => {})
    rmSync(userData, { recursive: true, force: true })
  },

  window: async ({ electronApp }, use, testInfo) => {
    const window = await electronApp.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await use(window)
    // Screenshots only on failure. The UI is redacted by design (values are
    // never rendered), so captures cannot contain fixture secret values.
    if (testInfo.status !== testInfo.expectedStatus) {
      const path = testInfo.outputPath('failure.png')
      await window.screenshot({ path }).catch(() => {})
      testInfo.attachments.push({ name: 'failure', path, contentType: 'image/png' })
    }
  }
})

/** Skip the first-run journey and land on the Workspace page. */
export async function skipOnboarding(window: Page): Promise<void> {
  await window.getByText('Skip', { exact: true }).click()
}

/** A file row in the workspace table, addressed by its unique aria-label. */
export function fileRow(window: Page, rel: string): ReturnType<Page['getByRole']> {
  return window.getByRole('button', { name: `Open ${rel}`, exact: true })
}

/** Right-click a file row and pick it as compare side A or B. */
export async function pickForCompare(window: Page, rel: string, side: 'A' | 'B'): Promise<void> {
  await fileRow(window, rel).click({ button: 'right' })
  await window
    .getByRole('menuitem', {
      name: side === 'A' ? /Compare as A \(source\)/ : /Compare as B \(target\)/
    })
    .click()
}

/** From the Workspace page: pair .env → .env.production and open the receipt. */
export async function openReceipt(window: Page): Promise<void> {
  await pickForCompare(window, 'app/.env', 'A')
  await pickForCompare(window, 'app/.env.production', 'B')
  await window.getByRole('button', { name: 'Compare', exact: true }).click()
  await expect(window.getByRole('heading', { name: 'Drift receipt' })).toBeVisible()
  // The receipt is computed automatically for a fresh pair.
  await expect(window.getByRole('cell', { name: 'SHARED_TOKEN' })).toBeVisible()
}

export { expect }
