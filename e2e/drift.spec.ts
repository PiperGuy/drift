import { test, expect, skipOnboarding, openReceipt, fileRow, FAKE } from './fixtures'

/**
 * Scan a fixture project with several .env* files, pair two of them and read
 * the drift receipt in the real UI — with every value redacted.
 */
test('scans the workspace, compares a pair and shows a redacted receipt', async ({
  window
}): Promise<void> => {
  await skipOnboarding(window)

  // The fixture root was scanned: all three .env* files of the project appear.
  await expect(fileRow(window, 'app/.env')).toBeVisible()
  await expect(fileRow(window, 'app/.env.production')).toBeVisible()
  await expect(fileRow(window, 'app/.env.local')).toBeVisible()

  await openReceipt(window)

  // Each drifted key is classified; NODE_ENV is marked ignored, never drift.
  // Badges are matched by their unique title so 'extra' can't hit 'EXTRA_ONLY'.
  const row = (key: string): ReturnType<typeof window.locator> =>
    window.getByRole('row').filter({ has: window.getByRole('cell', { name: key, exact: true }) })
  await expect(
    row('SHARED_TOKEN').getByTitle('Present on both sides, fingerprints differ')
  ).toBeVisible()
  await expect(row('NEW_FLAG').getByTitle('In A, absent from B')).toBeVisible()
  await expect(row('EXTRA_ONLY').getByTitle('In B only; never removed automatically')).toBeVisible()
  await expect(
    row('BLANK_KEY').getByTitle('Key present but empty on at least one side')
  ).toBeVisible()
  await expect(row('NODE_ENV').getByTitle('Expected to differ per environment')).toBeVisible()

  // Redaction: no raw value from either side is ever rendered.
  const body = (await window.locator('body').innerText()) ?? ''
  for (const value of Object.values(FAKE)) {
    expect(body.includes(value)).toBe(false)
  }
})
