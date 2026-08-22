// @vitest-environment jsdom
import { afterEach, beforeEach, test, vi } from 'vitest'
import assert from 'node:assert/strict'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { act } from 'react'
import type { EnvFileInfo, PlumbrApi, ScanResult } from '@shared/channels'
import { compareEnv } from '@shared/drift'
import { useWorkspace } from '@/store/workspace'
import { WorkspacePage } from './Workspace'
import { ReceiptPage } from './Receipt'

const file = (rel: string, project: string | null): EnvFileInfo => ({
  path: `/ws/${rel}`,
  rel,
  name: rel.split('/').pop()!,
  project,
  modifiedAt: Date.now() - 3600_000,
  size: 120
})

const scan: ScanResult = {
  root: '/ws',
  files: [
    file('api/.env', 'api'),
    file('api/.env.production', 'api'),
    file('api/.env.staging', 'api'),
    file('web/.env.local', 'web'),
    file('.env.example', null)
  ],
  projects: ['api', 'web'],
  scannedDirs: 12,
  durationMs: 3
}

/** Redacted shapes only. Fingerprints are opaque tokens; these strings must never render. */
const SECRET_FINGERPRINT = 'fp_SECRET_a1'
const shapes: Record<string, { key: string; fingerprint: string | null }[]> = {
  '/ws/api/.env': [
    { key: 'DATABASE_URL', fingerprint: SECRET_FINGERPRINT },
    { key: 'STRIPE_KEY', fingerprint: 'fp_b2' },
    { key: 'SENTRY_DSN', fingerprint: null },
    { key: 'NODE_ENV', fingerprint: 'fp_dev' }
  ],
  '/ws/api/.env.production': [
    { key: 'DATABASE_URL', fingerprint: SECRET_FINGERPRINT },
    { key: 'STRIPE_KEY', fingerprint: 'fp_zz' },
    { key: 'REDIS_URL', fingerprint: 'fp_e5' },
    { key: 'NODE_ENV', fingerprint: 'fp_prod' }
  ],
  '/ws/api/.env.staging': [{ key: 'DATABASE_URL', fingerprint: 'fp_s' }],
  '/ws/web/.env.local': [],
  '/ws/.env.example': [{ key: 'DATABASE_URL', fingerprint: null }]
}

const plumbr: PlumbrApi = {
  pickWorkspace: vi.fn(async () => '/ws'),
  scanWorkspace: vi.fn(async () => scan),
  envShape: vi.fn(async ({ path }) => ({
    path,
    name: path.split('/').pop()!,
    entries: shapes[path]
  })),
  compareEnv: vi.fn(async ({ left, right, ignore }) =>
    compareEnv(
      { name: left.split('/').pop()!, entries: shapes[left] },
      { name: right.split('/').pop()!, entries: shapes[right] },
      ignore
    )
  ),
  appInfo: vi.fn(async () => ({
    version: '0.1.0',
    platform: 'linux',
    electron: '43',
    node: '24',
    chrome: '1'
  }))
}

const initial = useWorkspace.getState()
beforeEach(() => {
  window.plumbr = plumbr
  useWorkspace.setState(initial, true)
})
afterEach(cleanup)

function assertNoFingerprints(): void {
  const html = document.body.innerHTML
  for (const entries of Object.values(shapes))
    for (const e of entries) if (e.fingerprint) assert.ok(!html.includes(e.fingerprint))
}

test('workspace: onboarding, then grouped overview with redacted key counts', async () => {
  render(<WorkspacePage />)
  assert.ok(screen.getByText(/Point Plumbr Env at a folder/))

  await act(() => useWorkspace.getState().grant())
  // First Git project opens by default with its environment matrix.
  const nav = screen.getByRole('navigation', { name: 'Projects' })
  assert.equal(within(nav).getAllByRole('button').length, 3)
  assert.ok(within(nav).getByText('no Git project'))
  const present = screen.getByRole('list', { name: 'Environments present' })
  assert.match(present.textContent!, /●\.env.*○local.*●staging.*○preview.*●production/)

  // Key counts come from envShape, blank keys called out, never a fingerprint.
  assert.ok(await screen.findByTitle('4 keys, 1 blank'))
  assert.ok(screen.getByTitle('4 keys, 0 blank'))
  assertNoFingerprints()

  // Pick A and B, and the receipt becomes reachable.
  const open = screen.getByRole('button', { name: /Open receipt/ })
  assert.ok(open.hasAttribute('disabled'))
  fireEvent.click(screen.getByRole('button', { name: 'Use api/.env as A' }))
  fireEvent.click(screen.getByRole('button', { name: 'Use api/.env.production as B' }))
  assert.ok(!open.hasAttribute('disabled'))
  assert.equal(useWorkspace.getState().left?.rel, 'api/.env')
  fireEvent.click(open)
  assert.equal(useWorkspace.getState().page, 'receipt')

  // Switching project loads that project's shapes only once.
  const calls = (plumbr.envShape as ReturnType<typeof vi.fn>).mock.calls.length
  await act(() => useWorkspace.getState().openProject('web'))
  assert.equal((plumbr.envShape as ReturnType<typeof vi.fn>).mock.calls.length, calls + 1)
})

test('receipt: empty state, then classes, filters, search and a plan with no apply', async () => {
  render(<ReceiptPage />)
  assert.ok(screen.getByText('No pair selected'))

  await act(async () => {
    useWorkspace.setState({ root: '/ws', scan, left: scan.files[0], right: scan.files[1] })
  })
  await screen.findByText('STRIPE_KEY')
  const receipt = useWorkspace.getState().receipt!
  assert.deepEqual(receipt.counts, {
    same: 1,
    changed: 1,
    missing: 1,
    extra: 1,
    blank: 0,
    ignored: 1
  })
  assert.ok(screen.getByText('keys to review'))
  assertNoFingerprints()

  // Review items first; SENTRY_DSN is "missing" (only in A) since B lacks it.
  const keys = (): string[] =>
    screen
      .getAllByRole('row')
      .slice(1)
      .map((r) => r.querySelector('td')?.textContent ?? '')
  assert.deepEqual(keys(), ['SENTRY_DSN', 'STRIPE_KEY', 'REDIS_URL', 'DATABASE_URL', 'NODE_ENV'])

  fireEvent.click(screen.getByRole('button', { name: /extra/ }))
  assert.deepEqual(keys(), ['REDIS_URL'])
  fireEvent.click(screen.getByRole('button', { name: /extra/ }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Search keys' }), {
    target: { value: 'stripe' }
  })
  assert.deepEqual(keys(), ['STRIPE_KEY'])
  assert.equal(screen.getByRole('button', { name: /same$/ }).getAttribute('disabled'), null)
  assert.ok(screen.getByRole('button', { name: /blank$/ }).hasAttribute('disabled'))

  fireEvent.click(screen.getByRole('tab', { name: /Dry-run plan · 3/ }))
  assert.deepEqual(keys(), ['STRIPE_KEY'])
  fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))
  assert.deepEqual(keys(), ['REDIS_URL', 'SENTRY_DSN', 'STRIPE_KEY'])
  assert.ok(screen.getByText(/no Apply in this build/))
  assert.equal(screen.queryByRole('button', { name: /apply/i }), null)

  // Swapping direction clears the receipt and recomputes it.
  fireEvent.click(screen.getByRole('button', { name: 'Swap A and B' }))
  await screen.findByText('STRIPE_KEY')
  assert.equal(useWorkspace.getState().receipt?.left, '.env.production')
})
