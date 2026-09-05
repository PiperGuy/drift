import { defineConfig } from '@playwright/test'

/**
 * Desktop E2E: launches the built Electron app (out/) with Playwright's
 * _electron driver. Run `npm run test:e2e` (builds first). On headless Linux
 * wrap in xvfb: `xvfb-run -a npm run test:e2e`. See docs/e2e.md.
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  // One app instance at a time: deterministic, and easy on CI runners.
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  outputDir: 'e2e-results',
  reporter: [['list']]
})
