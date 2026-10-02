// @vitest-environment jsdom
import { afterEach, beforeEach, test, vi } from 'vitest'
import assert from 'node:assert/strict'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { act } from 'react'
import type { EnvFileInfo, PlumbrApi, ProjectCompareResult, ScanResult } from '@shared/channels'
import { compareEnv } from '@shared/drift'
import { projectKey, useWorkspace } from '@/store/workspace'
import { WorkspacePage } from './Workspace'
import { ProjectList } from '@/components/app/ProjectList'
import { createRef } from 'react'
import { ReceiptPage } from './Receipt'
import { NO_PROJECT, fromOption, toOption } from '@/lib/projects'

const file = (rel: string, project: string | null): EnvFileInfo => ({
  path: `/ws/${rel}`,
  root: '/ws',
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
  '/ws/.env.example': [{ key: 'DATABASE_URL', fingerprint: null }],
  'vercel://7/prj_1/.env.production': [{ key: 'DATABASE_URL', fingerprint: 'fp_v' }]
}

/** The fake Vercel target's timestamp: every accepted write moves it, like the real platform. */
let vercelMtime = 1700000000000

const plumbr: PlumbrApi = {
  pickWorkspace: vi.fn(async () => ({ path: '/ws', kind: 'local' as const, label: '/ws' })),
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
  recentWorkspaces: vi.fn(async () => []),
  addSshRoot: vi.fn(async ({ host, path }) => ({
    path: `ssh://${host}${path}`,
    kind: 'ssh' as const,
    label: `${host}:${path}`
  })),
  removeRoot: vi.fn(async () => {}),
  listWorkspaces: vi.fn(async () => ({
    active: 1,
    all: [{ id: 1, name: 'Default', roots: 1, path: '/ws' }]
  })),
  createWorkspace: vi.fn(async (name) => ({ id: 2, name, roots: 0, path: null })),
  renameWorkspace: vi.fn(async () => {}),
  deleteWorkspace: vi.fn(async () => {}),
  switchWorkspace: vi.fn(async () => []),
  listHistory: vi.fn(async () => []),
  forgetData: vi.fn(async () => {}),
  clearCache: vi.fn(async () => {}),
  getSettings: vi.fn(async () => ({ mcpEnabled: true, onboarded: true })),
  setSettings: vi.fn(async (p) => ({
    mcpEnabled: p.mcpEnabled ?? true,
    onboarded: p.onboarded ?? true
  })),
  checkUpdates: vi.fn(async () => ({ status: 'current' as const, version: '0.1.0' })),
  mcpClients: vi.fn(async () => []),
  mcpInstall: vi.fn(async () => []),
  mcpUninstall: vi.fn(async () => []),
  revealValue: vi.fn(async () => ({ value: null, method: 'dialog' as const })),
  revealAll: vi.fn(async () => ({ values: {}, method: 'dialog' as const })),
  applyPlan: vi.fn(async () => ({ written: [], skipped: [], snapshot: 1 })),
  listSnapshots: vi.fn(async () => []),
  rollback: vi.fn(async () => {}),
  viewEnv: vi.fn(async () => ({ lines: [], lint: [], formatted: true })),
  formatEnv: vi.fn(async () => ({ changed: 0, snapshot: null })),
  setValues: vi.fn(async () => ({ written: [], snapshot: 1 })),
  onUpdate: vi.fn(() => () => {}),
  installUpdate: vi.fn(async () => {}),
  onFullscreen: vi.fn(() => () => {}),
  sshHosts: vi.fn(async () => []),
  vaultConnect: vi.fn(async () => {
    throw new Error('not in this test')
  }),
  vaultHistory: vi.fn(async () => {
    throw new Error('not in this test')
  }),
  vaultShapeAt: vi.fn(async () => {
    throw new Error('not in this test')
  }),
  vaultRestore: vi.fn(async () => {
    throw new Error('not in this test')
  }),
  providerConnect: vi.fn(async () => {
    throw new Error('not in this test')
  }),
  addDockerRoot: vi.fn(async () => {
    throw new Error('not in this test')
  }),
  dockerContainers: vi.fn(async () => []),
  awsProfiles: vi.fn(async () => []),
  ecsDiscover: vi.fn(async () => ({ clusters: [], services: [], tasks: [] })),
  rootsAll: vi.fn(async () => [
    {
      path: '/ws',
      kind: 'local' as const,
      label: 'laptop',
      workspace: 1,
      workspaceName: 'Default'
    },
    {
      path: 'vercel://7/prj_1',
      kind: 'vercel' as const,
      label: 'vercel:web',
      workspace: 2,
      workspaceName: 'Vercel web'
    }
  ]),
  projectCompare: vi.fn(async ({ left, right }): Promise<ProjectCompareResult> => {
    const a = scan.files.find((f) => f.rel === 'api/.env.production')!
    const b: EnvFileInfo = {
      path: 'vercel://7/prj_1/.env.production',
      root: 'vercel://7/prj_1',
      rel: '.env.production',
      name: '.env.production',
      project: 'web',
      modifiedAt: vercelMtime,
      size: 0
    }
    return {
      left: { ...left, files: 3 },
      right: { ...right, files: 3 },
      pairs: [
        {
          id: '.env.production',
          left: a,
          right: b,
          receipt: {
            id: 42,
            ...compareEnv(
              { name: a.name, entries: shapes[a.path] },
              { name: b.name, entries: [{ key: 'DATABASE_URL', fingerprint: 'fp_v' }] },
              ['NODE_ENV']
            )
          },
          error: null
        }
      ],
      onlyLeft: [scan.files[0], scan.files[2]],
      onlyRight: [
        { ...b, path: 'vercel://7/prj_1/.env.preview', rel: '.env.preview', name: '.env.preview' }
      ],
      ambiguous: []
    }
  }),
  appInfo: vi.fn(async () => ({
    version: '0.1.0',
    platform: 'linux',
    electron: '43',
    node: '24',
    chrome: '1',
    dataPath: '/tmp/plumbr.db',
    keyPersisted: true,
    mcp: {
      command: '/app/drift',
      args: ['/app/out/main/mcp.js', '--db', '/tmp/plumbr.db'],
      env: { ELECTRON_RUN_AS_NODE: '1' }
    }
  }))
}

// vercel://7/prj_1 is scanned when picked as a side: same shape as any scan, metadata only.
const vercelScan: ScanResult = {
  root: 'vercel://7/prj_1',
  files: ['.env.development', '.env.preview', '.env.production'].map((rel) => ({
    path: `vercel://7/prj_1/${rel}`,
    root: 'vercel://7/prj_1',
    rel,
    name: rel,
    project: 'web',
    modifiedAt: 1700000000000,
    size: 0
  })),
  projects: ['web'],
  scannedDirs: 1,
  durationMs: 1
}
plumbr.scanWorkspace = vi.fn(async ({ root }) => (root === 'vercel://7/prj_1' ? vercelScan : scan))

const initial = useWorkspace.getState()
beforeEach(() => {
  window.plumbr = plumbr
  useWorkspace.setState(initial, true)
})
afterEach(cleanup)

test('startup loads the workspace without a license or trial check', async () => {
  await act(() => useWorkspace.getState().init())

  assert.equal(useWorkspace.getState().onboarded, true)
  assert.equal((plumbr.getSettings as ReturnType<typeof vi.fn>).mock.calls.length, 1)
  assert.equal((plumbr.recentWorkspaces as ReturnType<typeof vi.fn>).mock.calls.length, 1)
})

function assertNoFingerprints(): void {
  const html = document.body.innerHTML
  for (const entries of Object.values(shapes))
    for (const e of entries) if (e.fingerprint) assert.ok(!html.includes(e.fingerprint))
}

test('workspace: onboarding, then grouped overview with redacted key counts', async () => {
  // The project list lives in the sidebar; the page shows the selected project's files.
  render(
    <>
      <ProjectList searchRef={createRef<HTMLInputElement>()} />
      <WorkspacePage />
    </>
  )
  assert.ok(screen.getByRole('heading', { level: 1, name: /Add a folder or a server to Drift/ }))

  await act(() => useWorkspace.getState().grant())
  // First Git project opens by default with its environment matrix.
  const nav = screen.getByRole('navigation', { name: 'Projects' })
  // Three project buttons; a single root has no remove control of its own.
  const projectButtons = within(nav)
    .getAllByRole('button')
    .filter((b) => !(b.getAttribute('aria-label') ?? '').startsWith('Remove '))
  assert.equal(projectButtons.length, 3)
  assert.ok(within(nav).getByText('no Git project'))
  const present = screen.getByRole('list', { name: 'Environments present' })
  assert.match(present.textContent!, /●\.env.*○local.*●staging.*○preview.*●production/)

  // Key counts come from envShape, blank keys called out, never a fingerprint.
  assert.ok(await screen.findByTitle('4 keys, 1 blank'))
  assert.ok(screen.getByTitle('4 keys, 0 blank'))
  assertNoFingerprints()

  // Nothing selected: no compare bar. Rows are buttons that open the file; compare is picked
  // from the row's context menu (exercised via the store here; Radix menus need a real pointer).
  assert.ok(!screen.queryByRole('button', { name: /^Compare/ }))
  assert.ok(screen.getByRole('button', { name: 'Open api/.env' }))
  const [envA, envB] = scan.files
  act(() => useWorkspace.getState().pick('left', envA))
  const open = screen.getByRole('button', { name: /^Compare/ })
  assert.ok(open.hasAttribute('disabled'))
  act(() => useWorkspace.getState().pick('right', envB))
  assert.ok(!open.hasAttribute('disabled'))
  assert.equal(useWorkspace.getState().left?.rel, 'api/.env')
  fireEvent.click(open)
  assert.equal(useWorkspace.getState().page, 'receipt')

  // Switching project loads that project's shapes only once.
  const calls = (plumbr.envShape as ReturnType<typeof vi.fn>).mock.calls.length
  await act(() => useWorkspace.getState().openProject(projectKey({ root: '/ws', project: 'web' })))
  assert.equal((plumbr.envShape as ReturnType<typeof vi.fn>).mock.calls.length, calls + 1)
})

test('receipt: empty state, then classes, filters, search and a plan with no apply', async () => {
  render(<ReceiptPage />)
  // No pair yet: the page offers the cross-source project picker instead.
  assert.ok(screen.getByRole('heading', { level: 1, name: 'Compare projects' }))

  await act(async () => {
    useWorkspace.setState({
      roots: [{ path: '/ws', kind: 'local', label: '/ws' }],
      scan,
      left: scan.files[0],
      right: scan.files[1]
    })
  })
  await screen.findByText('STRIPE_KEY')
  const receipt = useWorkspace.getState().receipt!
  assert.deepEqual(receipt.counts, {
    same: 1,
    changed: 1,
    missing: 1,
    extra: 1,
    blank: 0,
    unknown: 0,
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
  // Apply lives on the plan tab only, behind an approval dialog that lists the exact keys:
  // add + update pre-checked, review opt-in, keep never offered. Nothing is written until "Write".
  const applyBtn = screen.getByRole('button', { name: /Apply to B/ })
  fireEvent.click(applyBtn)
  const dialog = await screen.findByRole('dialog')
  const boxes = within(dialog).getAllByRole('checkbox') as HTMLInputElement[]
  assert.deepEqual(
    boxes.map((b) => [b.closest('label')!.textContent!.match(/[A-Z_]+/)![0], b.checked]),
    [
      ['SENTRY_DSN', true],
      ['STRIPE_KEY', true]
    ]
  )
  assert.equal(plumbr.applyPlan.mock.calls.length, 0)
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
  fireEvent.click(screen.getByRole('tab', { name: /Receipt · / }))
  assert.ok(!screen.queryByRole('button', { name: /Apply to B/ }))

  // Swapping direction clears the receipt and recomputes it.
  fireEvent.click(screen.getByRole('button', { name: 'Swap A and B' }))
  await screen.findByText('STRIPE_KEY')
  assert.equal(useWorkspace.getState().receipt?.left, '.env.production')
})

test('compare projects: source + project on each side, matched files with receipts, drill-down keeps both labels, apply quotes the plan', async () => {
  render(<ReceiptPage />)
  await act(() => useWorkspace.getState().loadWorkspaces())
  assert.ok(screen.getByRole('heading', { level: 1, name: 'Compare projects' }))
  // A: the local source, project api. B: the Vercel source, project web.
  fireEvent.change(screen.getByRole('combobox', { name: 'Source A' }), { target: { value: '/ws' } })
  await screen.findByRole('option', { name: 'api' })
  fireEvent.change(screen.getByRole('combobox', { name: 'Project A' }), {
    target: { value: 'api' }
  })
  fireEvent.change(screen.getByRole('combobox', { name: 'Source B' }), {
    target: { value: 'vercel://7/prj_1' }
  })
  await screen.findByRole('option', { name: 'web' })
  fireEvent.change(screen.getByRole('combobox', { name: 'Project B' }), {
    target: { value: 'web' }
  })
  fireEvent.click(screen.getByRole('button', { name: 'Compare projects' }))
  const table = await screen.findByRole('table', { name: 'Matched environment files' })
  assert.deepEqual(plumbr.projectCompare.mock.calls[0][0], {
    left: { root: '/ws', project: 'api' },
    right: { root: 'vercel://7/prj_1', project: 'web' }
  })
  const row = within(table).getAllByRole('row')[1]
  assert.match(
    row.textContent!,
    /\.env\.production.*laptop.*api.*api\/\.env\.production.*vercel:web.*web.*\.env\.production.*keys to review/
  )
  assert.match(screen.getByLabelText('Only in A').textContent!, /api\/\.env.*api\/\.env\.staging/)
  assert.match(screen.getByLabelText('Only in B').textContent!, /\.env\.preview/)
  assertNoFingerprints()

  // Drill down: the pair is the receipt; the header names source · project · file on both sides.
  const comparesBefore = plumbr.compareEnv.mock.calls.length
  fireEvent.click(within(row).getByRole('button', { name: /Open receipt/ }))
  assert.ok(await screen.findByRole('heading', { level: 1, name: 'Drift receipt' }))
  const header = screen.getByRole('heading', { level: 1, name: 'Drift receipt' }).parentElement!
  assert.match(
    header.textContent!,
    /laptop.*api.*api\/\.env\.production.*vercel:web.*web.*\.env\.production/
  )
  assert.equal(useWorkspace.getState().receipt?.id, 42)
  // The receipt came from the project compare: no second compare call.
  assert.equal(plumbr.compareEnv.mock.calls.length, comparesBefore)

  // Apply is available for the Vercel target; the dialog names the platform consequence and quotes the plan.
  fireEvent.click(screen.getByRole('tab', { name: /Dry-run plan/ }))
  const applyBtn = screen.getByRole('button', { name: /Apply to B/ })
  assert.ok(!applyBtn.hasAttribute('disabled'))
  fireEvent.click(applyBtn)
  const dialog = await screen.findByRole('dialog')
  assert.match(dialog.textContent!, /What this does on vercel:web/)
  assert.match(dialog.textContent!, /Only this target/)
  fireEvent.click(within(dialog).getByRole('button', { name: /^Write/ }))
  await waitFor(() => assert.equal(plumbr.applyPlan.mock.calls.length, 1))
  const req = plumbr.applyPlan.mock.calls[0][0]
  assert.equal(req.receipt, 42)
  assert.equal(req.right, 'vercel://7/prj_1/.env.production')
  assert.equal(req.left, '/ws/api/.env.production')

  // Back to the project view keeps the result.
  fireEvent.click(screen.getByRole('button', { name: 'Back to project comparison' }))
  assert.ok(await screen.findByRole('table', { name: 'Matched environment files' }))
})

test('apply is blocked for ephemeral ECS targets with the reason', async () => {
  render(<ReceiptPage />)
  const task: EnvFileInfo = {
    path: 'ecs://3/prod/task:0123456789abcdef/api/.env',
    root: 'ecs://3/prod/task:0123456789abcdef/api',
    rel: '.env',
    name: '.env',
    project: 'prod/0123456789abcdef/api',
    modifiedAt: 1,
    size: 0
  }
  plumbr.compareEnv = vi.fn(async () =>
    compareEnv({ name: '.env', entries: shapes['/ws/api/.env'] }, { name: '.env', entries: [] }, [])
  )
  await act(async () => {
    useWorkspace.setState({ left: scan.files[0], right: task })
  })
  await screen.findByText('STRIPE_KEY')
  fireEvent.click(screen.getByRole('tab', { name: /Dry-run plan/ }))
  const btn = screen.getByRole('button', { name: /Apply to B/ })
  assert.ok(btn.hasAttribute('disabled'))
  assert.match(btn.getAttribute('title') ?? '', /replaced on every deployment/)
})

test('project picker: the ungrouped group round-trips as null through a printable sentinel', async () => {
  // The <select> needs a string; null must come back as null and never collide with a real project.
  assert.equal(toOption(null), NO_PROJECT)
  assert.equal(fromOption(NO_PROJECT), null)
  assert.equal(fromOption(toOption('api')), 'api')
  assert.equal(fromOption(toOption('.')), '.')
  assert.match(NO_PROJECT, /^[\x21-\x7e]+$/) // printable ASCII only: never a control or NUL byte
  assert.ok(!scan.projects.includes(NO_PROJECT))

  render(<ReceiptPage />)
  await act(() => useWorkspace.getState().loadWorkspaces())
  fireEvent.change(screen.getByRole('combobox', { name: 'Source A' }), { target: { value: '/ws' } })
  const none = await screen.findByRole('option', { name: '(no git project)' })
  assert.equal((none as HTMLOptionElement).value, NO_PROJECT)
  fireEvent.change(screen.getByRole('combobox', { name: 'Project A' }), {
    target: { value: NO_PROJECT }
  })
  assert.deepEqual(useWorkspace.getState().projectSides.left, { root: '/ws', project: null })
  fireEvent.change(screen.getByRole('combobox', { name: 'Source B' }), {
    target: { value: 'vercel://7/prj_1' }
  })
  await screen.findByRole('option', { name: 'web' })
  fireEvent.change(screen.getByRole('combobox', { name: 'Project B' }), {
    target: { value: 'web' }
  })
  const before = plumbr.projectCompare.mock.calls.length
  fireEvent.click(screen.getByRole('button', { name: 'Compare projects' }))
  await waitFor(() => assert.equal(plumbr.projectCompare.mock.calls.length, before + 1))
  // Main receives null, not the sentinel string.
  assert.deepEqual(plumbr.projectCompare.mock.calls[before][0].left, { root: '/ws', project: null })
})

test('two sequential applies to an inactive cross-source B: the second quotes fresh target metadata', async () => {
  vercelMtime = 1700000000000
  // The fake platform behaves like main: a plan built on a stale timestamp is refused.
  plumbr.applyPlan = vi.fn(async (req) => {
    if (req.expectedMtime !== vercelMtime)
      throw new Error('B changed since this plan was made. Compare again, then apply.')
    vercelMtime += 1000
    return { written: req.keys, skipped: [], snapshot: 1, verified: true }
  })
  render(<ReceiptPage />)
  await act(() => useWorkspace.getState().loadWorkspaces())
  fireEvent.change(screen.getByRole('combobox', { name: 'Source A' }), { target: { value: '/ws' } })
  await screen.findByRole('option', { name: 'api' })
  fireEvent.change(screen.getByRole('combobox', { name: 'Project A' }), {
    target: { value: 'api' }
  })
  fireEvent.change(screen.getByRole('combobox', { name: 'Source B' }), {
    target: { value: 'vercel://7/prj_1' }
  })
  await screen.findByRole('option', { name: 'web' })
  fireEvent.change(screen.getByRole('combobox', { name: 'Project B' }), {
    target: { value: 'web' }
  })
  fireEvent.click(screen.getByRole('button', { name: 'Compare projects' }))
  const table = await screen.findByRole('table', { name: 'Matched environment files' })
  fireEvent.click(
    within(within(table).getAllByRole('row')[1]).getByRole('button', { name: /Open receipt/ })
  )
  await screen.findByRole('heading', { level: 1, name: 'Drift receipt' })
  assert.equal(useWorkspace.getState().right?.modifiedAt, 1700000000000)

  const write = async (): Promise<void> => {
    fireEvent.click(screen.getByRole('tab', { name: /Dry-run plan/ }))
    fireEvent.click(await screen.findByRole('button', { name: /Apply to B/ }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: /^Write/ }))
    // Success closes the dialog; a refusal keeps it open with the error.
    await waitFor(() => assert.ok(!screen.queryByRole('dialog')), { timeout: 3000 })
    await waitFor(() =>
      assert.ok(useWorkspace.getState().receipt && !useWorkspace.getState().comparing)
    )
  }
  await write()
  assert.equal(plumbr.applyPlan.mock.calls.length, 1)
  assert.equal(plumbr.applyPlan.mock.calls[0][0].expectedMtime, 1700000000000)
  // B lives in an inactive source: the rescan cannot refresh it, the fresh project comparison must.
  assert.equal(useWorkspace.getState().right?.modifiedAt, 1700000001000)

  await write()
  assert.equal(plumbr.applyPlan.mock.calls.length, 2)
  assert.equal(plumbr.applyPlan.mock.calls[1][0].expectedMtime, 1700000001000)
  assert.equal(useWorkspace.getState().right?.modifiedAt, 1700000002000)
})
