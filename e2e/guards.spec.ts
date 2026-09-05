import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, skipOnboarding, openReceipt } from './fixtures'

/**
 * Failure paths at the E2E boundary: a stale plan is refused and a cancelled
 * approval writes nothing. In both cases the target file is not modified.
 */
test('refuses a stale plan: the target changed after the compare', async ({
  window,
  workspace
}): Promise<void> => {
  const target = join(workspace, 'app', '.env.production')
  await skipOnboarding(window)
  await openReceipt(window)
  await window.getByRole('tab', { name: /Dry-run plan/ }).click()
  await window.getByRole('button', { name: /Apply to B/ }).click()

  // Another process edits the target while the approval dialog is open.
  const tampered = readFileSync(target, 'utf8') + 'TAMPERED_BY=another-process\n'
  writeFileSync(target, tampered)

  const dialog = window.getByRole('dialog')
  await dialog.getByRole('button', { name: /^Write \d+ keys?$/ }).click()

  await expect(dialog.getByRole('alert')).toContainText(/changed since this plan was made/)
  // Fail closed: the tampered content is exactly what is still on disk.
  expect(readFileSync(target, 'utf8')).toBe(tampered)
})

test('cancelled approval writes nothing', async ({ window, workspace }): Promise<void> => {
  const target = join(workspace, 'app', '.env.production')
  const before = readFileSync(target, 'utf8')
  await skipOnboarding(window)
  await openReceipt(window)
  await window.getByRole('tab', { name: /Dry-run plan/ }).click()
  await window.getByRole('button', { name: /Apply to B/ }).click()

  const dialog = window.getByRole('dialog')
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(dialog).not.toBeVisible()

  expect(readFileSync(target, 'utf8')).toBe(before)
})
