import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, skipOnboarding, openReceipt, FAKE } from './fixtures'

/**
 * The approved source→target sync path, end to end through the real UI:
 * plan tab → Apply dialog (the approval step) → write. Only the ticked keys
 * change, extras are retained, and no raw value appears in the receipt UI.
 */
test('applies only the approved keys and keeps extras', async ({
  window,
  workspace
}): Promise<void> => {
  const target = join(workspace, 'app', '.env.production')
  await skipOnboarding(window)
  await openReceipt(window)

  await window.getByRole('tab', { name: /Dry-run plan/ }).click()
  await window.getByRole('button', { name: /Apply to B/ }).click()

  // The approval dialog lists candidate keys; approve SHARED_TOKEN only.
  const dialog = window.getByRole('dialog')
  await expect(dialog.getByText(/Write to .*\.env\.production/)).toBeVisible()
  const candidate = (key: string): ReturnType<typeof dialog.locator> =>
    dialog.getByRole('listitem').filter({ hasText: key })
  await expect(candidate('SHARED_TOKEN').getByRole('checkbox')).toBeChecked()
  await candidate('NEW_FLAG').getByRole('checkbox').uncheck()
  // A blank-in-A key is review-only: never pre-approved.
  await expect(candidate('BLANK_KEY').getByRole('checkbox')).not.toBeChecked()

  await dialog.getByRole('button', { name: 'Write 1 key', exact: true }).click()

  // The receipt of the write is redacted: key count and location, no values.
  await expect(window.getByText(/Wrote 1 key to /)).toBeVisible()

  const after = readFileSync(target, 'utf8')
  expect(after.includes(`SHARED_TOKEN=${FAKE.sharedA}`)).toBe(true) // approved key updated
  expect(after.includes(FAKE.sharedB)).toBe(false) // old value gone
  expect(after.includes('NEW_FLAG')).toBe(false) // unticked key NOT written
  expect(after.includes(`EXTRA_ONLY=${FAKE.extra}`)).toBe(true) // extras retained
  expect(after.includes(`API_URL=${FAKE.apiUrl}`)).toBe(true) // untouched key intact
  expect(after.includes('NODE_ENV=production')).toBe(true) // ignored key intact

  // After the auto re-compare, SHARED_TOKEN reads as same and values stay hidden.
  await window.getByRole('tab', { name: /Receipt ·/ }).click()
  await expect(
    window
      .getByRole('row')
      .filter({ has: window.getByRole('cell', { name: 'SHARED_TOKEN', exact: true }) })
      .getByTitle('Same fingerprint on both sides')
  ).toBeVisible()
  const body = (await window.locator('body').innerText()) ?? ''
  for (const value of Object.values(FAKE)) {
    expect(body.includes(value)).toBe(false)
  }
})
