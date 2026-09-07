// @vitest-environment jsdom
import { afterEach, beforeEach, test, vi } from 'vitest'
import assert from 'node:assert/strict'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { PlumbrApi } from '@shared/channels'
import { AddSourceDialog } from './AddSourceDialog'
import { HOVER_CLOSE_MS, VAULT_GUIDE_LABEL } from './VaultGuide'
import { useWorkspace } from '@/store/workspace'

// The dialog only needs the ssh alias lookup at mount; nothing here submits.
const plumbr = {
  sshHosts: vi.fn(async () => []),
  awsProfiles: vi.fn(async () => ['default', 'dev']),
  dockerContainers: vi.fn(async () => ['api-1']),
  ecsDiscover: vi.fn(async () => ({ clusters: ['prod'], services: [], tasks: [] }))
} as unknown as PlumbrApi
beforeEach(() => {
  window.plumbr = plumbr
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function openVault(): void {
  render(<AddSourceDialog onClose={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: 'HashiCorp Vault' }))
}

const guideButton = (): HTMLElement => screen.getByRole('button', { name: VAULT_GUIDE_LABEL })
const guide = (): HTMLElement | null => screen.queryByRole('dialog', { name: VAULT_GUIDE_LABEL })
// Never hand a DOM node to assert.equal: on failure node:assert inspects it with
// depth 1000, and a React-rendered node's fiber links make that walk effectively
// endless, hanging the worker (CI OOM). waitFor fails every poll until closed.
const closed = (): Promise<void> => waitFor(() => assert.ok(!guide()))

test('vault guide: hover and keyboard focus reveal it, leaving hides it', async () => {
  // Fake timers: the close delay is a real setTimeout, and waiting it out on
  // the clock flakes under load (the 150 ms close and waitFor's 1 s budget can
  // both expire in one starved event-loop stall, so the check runs before
  // React flushes the close). Advancing the clock is deterministic and also
  // pins the grace period that lets the pointer travel into the popover.
  vi.useFakeTimers()
  const tick = (ms: number): Promise<void> => act(() => vi.advanceTimersByTimeAsync(ms))
  openVault()
  const btn = guideButton()
  assert.equal(btn.getAttribute('aria-expanded'), 'false')
  assert.ok(!guide())

  fireEvent.pointerEnter(btn)
  assert.ok(guide())
  assert.equal(btn.getAttribute('aria-expanded'), 'true')
  fireEvent.pointerLeave(btn)
  await tick(HOVER_CLOSE_MS - 1)
  assert.ok(guide()) // still open: the pointer may be on its way into the popover
  await tick(1)
  assert.ok(!guide())

  fireEvent.focus(btn)
  assert.ok(guide())
  fireEvent.blur(btn)
  await tick(HOVER_CLOSE_MS)
  assert.ok(!guide())
  // First mount of the full dialog costs ~2s in jsdom; room for a loaded box.
}, 30_000)

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
  // Height is fixed (not content-sized) yet capped to the viewport, and the form
  // is the scroll container; the sidebar stacks above it on narrow widths
  // instead of squeezing the fields.
  assert.match(content.className, /(^|\s)h-\[min\(36rem,calc\(100dvh-2rem\)\)\]/)
  assert.doesNotMatch(content.className, /max-h-/)
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
    'AWS Secrets Manager',
    'HashiCorp Vault',
    'GitHub Actions',
    'Vercel',
    'Railway',
    'Render',
    'Dokploy',
    'Coolify'
  ]
  for (const n of names) assert.ok(screen.getByRole('button', { name: new RegExp(`^${n}`) }), n)
  // No guide outside the Vault form.
  assert.ok(!screen.queryByRole('button', { name: VAULT_GUIDE_LABEL }))
})

test('every source is real: no "coming soon" anywhere, each form gates Connect on its own fields', async () => {
  render(<AddSourceDialog onClose={() => {}} />)
  assert.doesNotMatch(document.body.textContent ?? '', /coming soon|\bsoon\b/i)
  const connect = (): HTMLElement =>
    screen.getByRole('button', { name: /Connect and scan|Choose directory/ })
  const type = (label: RegExp, value: string): void =>
    fireEvent.change(screen.getByLabelText(label), { target: { value } })
  const cases: [string, [RegExp, string][]][] = [
    [
      'Docker container',
      [
        [/^Container/, 'api-1'],
        [/Directory in the container/, '/app']
      ]
    ],
    [
      'Vercel',
      [
        [/^Project/, 'web'],
        [/^Token/, 'unit-token']
      ]
    ],
    [
      'GitHub Actions',
      [
        [/^Owner/, 'acme'],
        [/^Token/, 'unit-token']
      ]
    ],
    [
      'Railway',
      [
        [/^Project/, 'shop'],
        [/^Token/, 'unit-token']
      ]
    ],
    ['Render', [[/^API key/, 'unit-key']]],
    [
      'Dokploy',
      [
        [/^Instance URL/, 'https://dokploy.example.com'],
        [/^API key/, 'k']
      ]
    ],
    [
      'Coolify',
      [
        [/^Instance URL/, 'https://coolify.example.com'],
        [/^API token/, 't']
      ]
    ],
    [
      'AWS Secrets Manager',
      [
        [/^Region/, 'eu-west-1'],
        [/^Secret name/, 'prod/api']
      ]
    ]
  ]
  for (const [source, fields] of cases) {
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${source}`) }))
    assert.ok(connect().hasAttribute('disabled'), `${source}: disabled before input`)
    for (const [label, value] of fields) type(label, value)
    assert.ok(!connect().hasAttribute('disabled'), `${source}: enabled after input`)
  }
  // ECS: cluster, service/task and container are picked explicitly; no read runs until then.
  fireEvent.click(screen.getByRole('button', { name: /^ECS container/ }))
  type(/^Region/, 'eu-west-1')
  assert.ok(connect().hasAttribute('disabled'))
  type(/^Cluster/, 'prod')
  type(/^Service or task/, 'service:api')
  assert.ok(connect().hasAttribute('disabled'))
  type(/^Container/, 'api')
  assert.ok(!connect().hasAttribute('disabled'))
  // The token fields never echo into the page as plain text.
  assert.ok(!document.body.innerHTML.includes('unit-token'))
  // Nine Radix forms through jsdom: slow under a loaded CI box, so give it room.
}, 30_000)

test('update source: an AWS Secrets Manager prefix source prefills `prefix/`, a single secret does not', () => {
  const seed = (prefix: boolean): void => {
    useWorkspace.setState({
      workspace: 1,
      workspaces: [{ id: 1, name: 'Prod', roots: 1, path: 'aws-sm://3/prod' }],
      roots: [
        {
          path: 'aws-sm://3/prod',
          kind: 'aws-sm',
          label: 'Prod',
          ...(prefix ? { prefix: true } : {})
        }
      ]
    })
    render(<AddSourceDialog mode="edit" onClose={() => {}} />)
  }
  seed(true)
  assert.equal((screen.getByLabelText(/^Secret name/) as HTMLInputElement).value, 'prod/')
  cleanup()
  seed(false)
  assert.equal((screen.getByLabelText(/^Secret name/) as HTMLInputElement).value, 'prod')
})
