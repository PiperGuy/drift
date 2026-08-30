// @vitest-environment jsdom
import { afterEach, beforeEach, test, vi } from 'vitest'
import assert from 'node:assert/strict'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { PlumbrApi } from '@shared/channels'
import { AddSourceDialog } from './AddSourceDialog'
import { VAULT_GUIDE_LABEL } from './VaultGuide'

// The dialog only needs the ssh alias lookup at mount; nothing here submits.
const plumbr = { sshHosts: vi.fn(async () => []) } as unknown as PlumbrApi
beforeEach(() => {
  window.plumbr = plumbr
})
afterEach(cleanup)

function openVault(): void {
  render(<AddSourceDialog onClose={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: 'HashiCorp Vault' }))
}

const guideButton = (): HTMLElement => screen.getByRole('button', { name: VAULT_GUIDE_LABEL })
const guide = (): HTMLElement | null => screen.queryByRole('dialog', { name: VAULT_GUIDE_LABEL })
const closed = (): Promise<void> => waitFor(() => assert.equal(guide(), null))

test('vault guide: hover and keyboard focus reveal it, leaving hides it', async () => {
  openVault()
  const btn = guideButton()
  assert.equal(btn.getAttribute('aria-expanded'), 'false')
  assert.equal(guide(), null)

  fireEvent.pointerEnter(btn)
  assert.ok(guide())
  assert.equal(btn.getAttribute('aria-expanded'), 'true')
  fireEvent.pointerLeave(btn)
  await closed()

  fireEvent.focus(btn)
  assert.ok(guide())
  fireEvent.blur(btn)
  await closed()
})

test('vault guide: click pins it open, click again or Escape closes it', async () => {
  openVault()
  const btn = guideButton()
  fireEvent.click(btn)
  assert.ok(guide())
  assert.equal(btn.getAttribute('aria-pressed'), 'true')
  // Pinned: moving the pointer away no longer dismisses it.
  fireEvent.pointerLeave(btn)
  await new Promise((r) => setTimeout(r, 250))
  assert.ok(guide())

  fireEvent.click(btn)
  await closed()
  assert.equal(btn.getAttribute('aria-pressed'), 'false')

  fireEvent.click(btn)
  assert.ok(guide())
  fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
  await closed()
  // The source dialog itself survives the Escape that closed the guide.
  assert.ok(screen.getByRole('button', { name: /Connect and scan/ }))
})

test('vault guide: one step per form field, redacted placeholders, no token-shaped text', () => {
  openVault()
  fireEvent.click(guideButton())
  const g = guide()!
  const text = g.textContent!
  for (const field of ['Address', 'Namespace', 'KV v2 path', 'Token', 'AppRole', 'CA certificate'])
    assert.ok(text.includes(field), field)
  // What connectVault actually asks Vault for, so the guide can't drift into invented APIs.
  for (const s of ['VAULT_ADDR', 'vault login', 'secret/apps/api', 'metadata/', 'data/'])
    assert.ok(text.includes(s), s)
  assert.ok(text.includes('hvs.••••'))
  assert.doesNotMatch(text, /hvs\.[A-Za-z0-9]{8,}/)
  assert.doesNotMatch(document.body.innerHTML, /hvs\.[A-Za-z0-9]{8,}/)
  // Guide is informational: it neither replaces nor relaxes the form's own gating.
  const connect = screen.getByRole('button', { name: /Connect and scan/ })
  assert.ok(connect.hasAttribute('disabled'))
})

test('add source: shell scrolls instead of overflowing, every source type stays reachable', () => {
  render(<AddSourceDialog onClose={() => {}} />)
  const content = screen.getByRole('dialog', { name: 'Local folder' })
  const form = content.querySelector('form')!
  // Height is capped to the viewport and the form is the scroll container; the
  // sidebar stacks above it on narrow widths instead of squeezing the fields.
  assert.match(content.className, /max-h-\[calc\(100dvh-2rem\)\]/)
  assert.match(content.className, /overflow-hidden/)
  assert.match(form.className, /overflow-y-auto/)
  assert.match(form.className, /min-h-0/)
  const aside = screen.getByRole('complementary', { name: 'Source types' })
  assert.match(aside.className, /border-b/)
  const grid = aside.parentElement!
  assert.match(grid.className, /sm:grid-cols-/)
  assert.doesNotMatch(grid.className, /(^|\s)grid-cols-\[/)
  const names = [
    'Local folder',
    'SSH server',
    'EC2 instance',
    'Docker container',
    'ECS container',
    'HashiCorp Vault',
    'AWS Secrets Manager'
  ]
  for (const n of names) assert.ok(screen.getByRole('button', { name: new RegExp(`^${n}`) }), n)
  // No guide outside the Vault form.
  assert.equal(screen.queryByRole('button', { name: VAULT_GUIDE_LABEL }), null)
})
