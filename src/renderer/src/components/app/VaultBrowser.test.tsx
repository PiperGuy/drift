// @vitest-environment jsdom
import { afterEach, beforeEach, test, vi } from 'vitest'
import assert from 'node:assert/strict'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { PlumbrApi, VaultDiscovery, VaultHistory, VaultListing } from '@shared/channels'
import { AddSourceDialog } from './AddSourceDialog'
import { useWorkspace } from '@/store/workspace'

const SESSION = '11111111-2222-4333-8444-555555555555'
const TOKEN = 'unit-root-token-not-real'

const discovery = (over: Partial<VaultDiscovery> = {}): VaultDiscovery => ({
  session: SESSION,
  vaultVersion: '1.21.0',
  token: {
    accessor: 'acc',
    displayName: 'root',
    policies: ['root'],
    expireTime: null,
    renewable: false,
    type: 'service'
  },
  mounts: [
    { path: 'kv-team', description: '' },
    { path: 'secret', description: 'apps' }
  ],
  mountsNote: '1 other mount (KV v1 or other engines) not shown: Drift browses KV v2 only.',
  warnings: ['This is a ROOT token. Use a scoped token instead wherever possible.'],
  ...over
})

const tree: Record<string, VaultListing> = {
  'secret/': {
    state: 'ok',
    truncated: false,
    nodes: [
      { name: 'apps', path: 'apps', kind: 'folder' },
      { name: 'ops', path: 'ops', kind: 'folder' }
    ]
  },
  'secret/apps': {
    state: 'ok',
    truncated: false,
    nodes: [{ name: 'api', path: 'apps/api', kind: 'folder' }]
  },
  'secret/apps/api': {
    state: 'ok',
    truncated: false,
    nodes: [
      { name: 'prod', path: 'apps/api/prod', kind: 'secret' },
      { name: 'staging', path: 'apps/api/staging', kind: 'secret' }
    ]
  },
  'secret/ops': {
    state: 'error',
    denied: true,
    message: 'No list permission on secret/metadata/ops. Siblings you can list are unaffected.'
  },
  'kv-team/': { state: 'empty' }
}
const history: VaultHistory = {
  path: 'secret/apps/api/prod',
  currentVersion: 2,
  oldestVersion: 1,
  maxVersions: 0,
  casRequired: false,
  deleteVersionAfter: '0s',
  updatedTime: '',
  versions: [
    { version: 2, createdTime: new Date().toISOString(), deletionTime: null, destroyed: false },
    { version: 1, createdTime: new Date().toISOString(), deletionTime: 'x', destroyed: false }
  ]
}

let plumbr: Record<string, ReturnType<typeof vi.fn>>
const createSource = vi.fn(async () => {})
beforeEach(() => {
  plumbr = {
    sshHosts: vi.fn(async () => []),
    awsProfiles: vi.fn(async () => []),
    vaultDiscover: vi.fn(async () => discovery()),
    vaultDiscoverList: vi.fn(
      async ({ mount, folder }: { mount: string; folder: string }) =>
        tree[`${mount}/${folder}`] ?? { state: 'empty' }
    ),
    vaultDiscoverMount: vi.fn(async ({ path }: { path: string }) => ({
      mount: { path: 'secret', description: '' },
      folder: path.replace(/^secret\/?/, '')
    })),
    vaultDiscoverVersions: vi.fn(async () => history),
    vaultDiscoverEnd: vi.fn(async () => {})
  }
  window.plumbr = plumbr as unknown as PlumbrApi
  createSource.mockClear()
  useWorkspace.setState({ createSource })
})
afterEach(() => cleanup())

async function signIn(expectTree = true): Promise<void> {
  render(<AddSourceDialog onClose={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: 'HashiCorp Vault' }))
  assert.ok(screen.getByRole('tab', { name: 'Browse Vault', selected: true }))
  const go = screen.getByRole('button', { name: /Sign in and browse/ })
  assert.ok(go.hasAttribute('disabled'))
  fireEvent.change(screen.getByLabelText(/^Address/), {
    target: { value: 'https://vault.example.com' }
  })
  fireEvent.change(screen.getByLabelText(/^Token/), { target: { value: TOKEN } })
  fireEvent.click(go)
  if (expectTree) await screen.findByRole('tree')
}
const item = (name: RegExp): HTMLElement => screen.getByRole('treeitem', { name })

test('browse: sign in once, mounts listed, children load lazily, token leaves the form', async () => {
  await signIn()
  assert.deepEqual(plumbr.vaultDiscover.mock.calls[0][0], {
    address: 'https://vault.example.com',
    namespace: undefined,
    caPem: undefined,
    auth: { kind: 'token', token: TOKEN }
  })
  assert.ok(screen.getByText(/ROOT token/))
  assert.ok(screen.getByText(/KV v2 only/))
  assert.ok(item(/^secret/) && item(/^kv-team/))
  assert.equal(plumbr.vaultDiscoverList.mock.calls.length, 0) // nothing listed until expanded
  // The credential field is gone and its value is not in the page.
  assert.ok(!screen.queryByLabelText(/^Token/))
  assert.ok(!document.body.innerHTML.includes(TOKEN))

  fireEvent.click(item(/^secret/))
  await waitFor(() => assert.ok(item(/^apps$/)))
  fireEvent.click(item(/^apps$/))
  await waitFor(() => assert.ok(item(/^api$/)))
  fireEvent.click(item(/^api$/))
  await waitFor(() => assert.ok(item(/^prod$/)))
  assert.equal(plumbr.vaultDiscoverList.mock.calls.length, 3)
  assert.equal(item(/^prod$/).getAttribute('aria-level'), '4') // mount → apps → api → prod
}, 30_000)

test('browse: denied branch is labelled in place, empty mount is not a misleading blank', async () => {
  await signIn()
  fireEvent.click(item(/^secret/))
  await waitFor(() => assert.ok(item(/^ops$/)))
  fireEvent.click(item(/^ops$/))
  await waitFor(() => assert.ok(item(/No list permission on secret\/metadata\/ops/)))
  assert.ok(item(/^apps$/)) // sibling still there
  fireEvent.click(item(/^kv-team/))
  await waitFor(() =>
    assert.ok(item(/Nothing listed here \(empty, or this token may not list it\)/))
  )
})

test('browse: picking a secret shows its versions (metadata) and connects via the session', async () => {
  await signIn()
  // Nothing picked yet: Connect stays disabled.
  assert.ok(screen.getByRole('button', { name: /Connect and scan/ }).hasAttribute('disabled'))
  fireEvent.click(item(/^secret/))
  await waitFor(() => item(/^apps$/))
  fireEvent.click(item(/^apps$/))
  await waitFor(() => item(/^api$/))
  fireEvent.click(item(/^api$/))
  await waitFor(() => item(/^prod$/))
  assert.ok(screen.getByRole('button', { name: /Connect folder/ })) // the last folder click picked it
  fireEvent.click(item(/^prod$/))
  const connect = screen.getByRole('button', { name: /Connect and scan/ })
  assert.equal(item(/^prod$/).getAttribute('aria-selected'), 'true')
  const versions = await screen.findByRole('list', { name: 'Versions of secret/apps/api/prod' })
  assert.ok(within(versions).getByText('current'))
  assert.ok(within(versions).getByText('deleted'))
  fireEvent.click(connect)
  await waitFor(() => assert.equal(createSource.mock.calls.length, 1))
  const spec = (createSource.mock.calls[0] as unknown as [Record<string, unknown>])[0]
  assert.equal(spec['path'], 'secret/apps/api/prod')
  assert.deepEqual(spec['auth'], { kind: 'session', session: SESSION })
  assert.ok(!JSON.stringify(spec).includes(TOKEN))
})

test('browse: keyboard tree — arrows move and open, Enter picks a folder as one app source', async () => {
  await signIn()
  const secret = item(/^secret/)
  secret.focus()
  fireEvent.keyDown(secret, { key: 'ArrowRight' })
  await waitFor(() => assert.equal(item(/^secret/).getAttribute('aria-expanded'), 'true'))
  await waitFor(() => item(/^apps$/))
  fireEvent.keyDown(item(/^secret/), { key: 'ArrowDown' })
  await waitFor(() => assert.ok(document.activeElement === item(/^apps$/)))
  assert.equal(item(/^apps$/).tabIndex, 0) // roving focus
  assert.equal(item(/^secret/).tabIndex, -1)
  fireEvent.keyDown(item(/^apps$/), { key: 'Enter' })
  await waitFor(() => assert.equal(item(/^apps$/).getAttribute('aria-selected'), 'true'))
  assert.ok(screen.getByRole('button', { name: /Connect folder/ }))
  fireEvent.keyDown(item(/^apps$/), { key: 'ArrowLeft' }) // collapse
  await waitFor(() => assert.equal(item(/^apps$/).getAttribute('aria-expanded'), 'false'))
  fireEvent.keyDown(item(/^apps$/), { key: 'ArrowLeft' }) // to parent
  await waitFor(() => assert.ok(document.activeElement === item(/^secret/)))
})

test('browse: constrained token cannot list mounts — explained, and a typed path opens', async () => {
  plumbr.vaultDiscover.mockResolvedValueOnce(
    discovery({
      mounts: null,
      mountsNote: 'This token may not list mounts (that needs read on sys/mounts).',
      warnings: []
    })
  )
  await signIn(false) // no tree yet: the empty state is shown instead
  await screen.findByText(/may not list mounts/)
  assert.ok(screen.getByText(/Mount listing is not allowed for this token/))
  fireEvent.change(screen.getByLabelText('Open a mount or path'), {
    target: { value: 'secret/apps' }
  })
  fireEvent.click(screen.getByRole('button', { name: 'Open' }))
  await waitFor(() => assert.ok(item(/^secret\/apps$/)))
  assert.deepEqual(plumbr.vaultDiscoverMount.mock.calls[0][0], {
    session: SESSION,
    path: 'secret/apps'
  })
  await waitFor(() => assert.ok(item(/^api$/)))
})

test('browse: sign-in errors surface, Sign out and closing end the session, path mode remains', async () => {
  plumbr.vaultDiscover.mockRejectedValueOnce(
    new Error('Vault token lookup: HTTP 403 — permission denied')
  )
  const onClose = vi.fn()
  const { unmount } = render(<AddSourceDialog onClose={onClose} />)
  fireEvent.click(screen.getByRole('button', { name: 'HashiCorp Vault' }))
  fireEvent.change(screen.getByLabelText(/^Address/), { target: { value: 'https://v.example' } })
  fireEvent.change(screen.getByLabelText(/^Token/), { target: { value: TOKEN } })
  fireEvent.click(screen.getByRole('button', { name: /Sign in and browse/ }))
  const alert = await screen.findByRole('alert')
  assert.match(alert.textContent ?? '', /permission denied/)
  assert.ok(!alert.textContent!.includes(TOKEN))

  fireEvent.click(screen.getByRole('button', { name: /Sign in and browse/ }))
  await screen.findByRole('tree')
  fireEvent.click(screen.getByRole('button', { name: /Sign out/ }))
  await waitFor(() => assert.deepEqual(plumbr.vaultDiscoverEnd.mock.calls.at(-1), [SESSION]))

  // Direct path entry is still there for people who know the path.
  fireEvent.click(screen.getByRole('tab', { name: 'Enter a path' }))
  assert.ok(screen.getByLabelText(/^KV v2 path/))
  fireEvent.click(screen.getByRole('tab', { name: 'Browse Vault' }))
  fireEvent.change(screen.getByLabelText(/^Token/), { target: { value: TOKEN } })
  fireEvent.click(screen.getByRole('button', { name: /Sign in and browse/ }))
  await screen.findByRole('tree')
  plumbr.vaultDiscoverEnd.mockClear()
  unmount()
  assert.deepEqual(plumbr.vaultDiscoverEnd.mock.calls, [[SESSION]])
}, 30_000)

/** React reports duplicate row keys through console.error; none may appear. */
function watchKeys(): () => void {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
  return () => {
    const dup = spy.mock.calls.some((c) => String(c[0]).includes('same key'))
    spy.mockRestore()
    assert.ok(!dup, 'duplicate React keys in the tree')
  }
}
const openPath = (path: string): void => {
  fireEvent.change(screen.getByLabelText('Open a mount or path'), { target: { value: path } })
  fireEvent.click(screen.getByRole('button', { name: 'Open' }))
}
const count = (name: RegExp): number => screen.queryAllByRole('treeitem', { name }).length

test('typed path under an expanded mount is revealed in place: one row, focused, no duplicate ids', async () => {
  const done = watchKeys()
  await signIn()
  fireEvent.click(item(/^secret/))
  await waitFor(() => item(/^apps$/))
  fireEvent.click(item(/^apps$/)) // expanded by hand first
  await waitFor(() => item(/^api$/))

  openPath('secret/apps/api')
  await waitFor(() => item(/^prod$/)) // api opened in place, its secrets listed
  assert.equal(count(/^api$/), 1)
  assert.equal(count(/^secret\/apps\/api$/), 0) // no second, typed root for the same place
  assert.equal(item(/^api$/).getAttribute('aria-expanded'), 'true')
  await waitFor(() => assert.ok(document.activeElement === item(/^api$/)))
  assert.equal(item(/^api$/).tabIndex, 0) // roving focus follows

  // Keyboard still walks the single tree: ↓ goes to api's first secret.
  fireEvent.keyDown(item(/^api$/), { key: 'ArrowDown' })
  await waitFor(() => assert.ok(document.activeElement === item(/^prod$/)))

  // A typed secret path is revealed and the secret itself is focused.
  openPath('secret/apps/api/staging')
  await waitFor(() => assert.ok(document.activeElement === item(/^staging$/)))
  assert.equal(count(/^staging$/), 1)
  done()
}, 30_000)

test('typed path under a collapsed mount opens every folder down to it', async () => {
  const done = watchKeys()
  await signIn()
  openPath('secret/apps/api')
  await waitFor(() => item(/^prod$/))
  for (const n of [/^secret/, /^apps$/, /^api$/])
    assert.equal(item(n).getAttribute('aria-expanded'), 'true')
  assert.equal(count(/^secret\/apps\/api$/), 0)
  await waitFor(() => assert.ok(document.activeElement === item(/^api$/)))
  done()
}, 30_000)

test('constrained token: a broader typed root absorbs a narrower one; re-typing reveals in place', async () => {
  plumbr.vaultDiscover.mockResolvedValueOnce(
    discovery({ mounts: null, mountsNote: 'This token may not list mounts.', warnings: [] })
  )
  const done = watchKeys()
  await signIn(false)
  await screen.findByText(/may not list mounts/)
  openPath('secret/apps/api')
  await waitFor(() => item(/^prod$/))
  assert.equal(count(/^secret\/apps\/api$/), 1)

  openPath('secret/apps')
  await waitFor(() => item(/^api$/))
  assert.equal(count(/^secret\/apps$/), 1)
  assert.equal(count(/^secret\/apps\/api$/), 0) // the narrower root was absorbed
  await waitFor(() => assert.ok(document.activeElement === item(/^secret\/apps$/)))

  openPath('secret/apps/api') // now inside the secret/apps root: revealed, not re-added
  await waitFor(() => item(/^prod$/))
  assert.equal(count(/^api$/), 1)
  assert.equal(count(/^secret\/apps\/api$/), 0)
  await waitFor(() => assert.ok(document.activeElement === item(/^api$/)))
  done()
}, 30_000)

test('enumerated mount whose root cannot be listed: a typed path below it still appears, as its own root', async () => {
  // Common for scoped tokens: the mount is listed (sys/internal/ui/mounts), its root is not.
  plumbr.vaultDiscoverList.mockImplementation(
    async ({ mount, folder }: { mount: string; folder: string }) =>
      mount === 'secret' && folder === ''
        ? { state: 'error', denied: true, message: 'No list permission on secret/metadata.' }
        : (tree[`${mount}/${folder}`] ?? { state: 'empty' })
  )
  const done = watchKeys()
  await signIn()
  openPath('secret/apps/api')
  await waitFor(() => item(/^prod$/)) // reachable and browsable despite the denied root
  assert.equal(count(/^secret\/apps\/api$/), 1)
  await waitFor(() => assert.ok(document.activeElement === item(/^secret\/apps\/api$/)))
  // The mount itself still explains its own refusal in place.
  fireEvent.click(item(/^secret(?!\/)/))
  await waitFor(() => item(/No list permission on secret\/metadata/))
  assert.equal(count(/^api$/), 0)
  assert.equal(count(/^prod$/), 1)
  done()
}, 30_000)

test('Enter while an open is in flight does not start a second one', async () => {
  plumbr.vaultDiscover.mockResolvedValueOnce(
    discovery({ mounts: null, mountsNote: 'This token may not list mounts.', warnings: [] })
  )
  let release!: () => void
  plumbr.vaultDiscoverMount.mockImplementationOnce(
    () =>
      new Promise((r) => {
        release = () =>
          r({ mount: { path: 'secret', description: '' }, folder: 'apps', secret: false })
      })
  )
  const done = watchKeys()
  await signIn(false)
  await screen.findByText(/may not list mounts/)
  const input = screen.getByLabelText('Open a mount or path')
  fireEvent.change(input, { target: { value: 'secret/apps' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  fireEvent.change(input, { target: { value: 'secret/apps/api' } })
  fireEvent.keyDown(input, { key: 'Enter' }) // ignored: the first open is still running
  assert.equal(plumbr.vaultDiscoverMount.mock.calls.length, 1)
  release()
  await waitFor(() => item(/^api$/))
  assert.equal(count(/^secret\/apps$/), 1)
  done()
}, 30_000)

test('a typed secret with no covering root is a pickable secret row, not a folder', async () => {
  plumbr.vaultDiscover.mockResolvedValueOnce(
    discovery({ mounts: null, mountsNote: 'This token may not list mounts.', warnings: [] })
  )
  plumbr.vaultDiscoverMount.mockResolvedValueOnce({
    mount: { path: 'secret', description: '' },
    folder: 'apps/api/prod',
    secret: true
  })
  const done = watchKeys()
  await signIn(false)
  await screen.findByText(/may not list mounts/)
  openPath('secret/apps/api/prod')
  await waitFor(() => item(/^secret\/apps\/api\/prod$/))
  const row = item(/^secret\/apps\/api\/prod$/)
  assert.equal(row.getAttribute('aria-expanded'), null) // a secret, not an expandable folder
  await waitFor(() => assert.ok(document.activeElement === item(/^secret\/apps\/api\/prod$/)))
  // Its folder check (one LIST) finds nothing, so no folder row is drawn for it.
  assert.equal(count(/^secret\/apps\/api\/prod$/), 1)
  fireEvent.click(row)
  await screen.findByRole('list', { name: 'Versions of secret/apps/api/prod' })
  assert.ok(screen.getByRole('button', { name: /Connect and scan/ }))
  done()
}, 30_000)

test('a broader typed root that cannot be listed never hides a narrower one', async () => {
  plumbr.vaultDiscover.mockResolvedValueOnce(
    discovery({ mounts: null, mountsNote: 'This token may not list mounts.', warnings: [] })
  )
  // Policy lists secret/apps/api but not secret/apps.
  plumbr.vaultDiscoverList.mockImplementation(
    async ({ mount, folder }: { mount: string; folder: string }) =>
      folder === 'apps'
        ? { state: 'error', denied: true, message: 'No list permission on secret/metadata/apps.' }
        : (tree[`${mount}/${folder}`] ?? { state: 'empty' })
  )
  const done = watchKeys()
  await signIn(false)
  await screen.findByText(/may not list mounts/)
  openPath('secret/apps/api')
  await waitFor(() => item(/^prod$/))
  openPath('secret/apps')
  await waitFor(() => item(/No list permission on secret\/metadata\/apps/))
  // The narrower root is still there and still browsable.
  assert.equal(count(/^secret\/apps\/api$/), 1)
  assert.equal(count(/^prod$/), 1)
  done()
}, 30_000)

test('a typed path that is both a secret and a folder shows both, folder focused', async () => {
  plumbr.vaultDiscover.mockResolvedValueOnce(
    discovery({ mounts: null, mountsNote: 'This token may not list mounts.', warnings: [] })
  )
  plumbr.vaultDiscoverMount.mockResolvedValueOnce({
    mount: { path: 'secret', description: '' },
    folder: 'apps/api',
    secret: true
  })
  const done = watchKeys()
  await signIn(false)
  await screen.findByText(/may not list mounts/)
  openPath('secret/apps/api')
  await waitFor(() => item(/^prod$/)) // the folder side is browsable
  const rows = screen.getAllByRole('treeitem', { name: /^secret\/apps\/api$/ })
  assert.equal(rows.length, 2)
  assert.deepEqual(rows.map((r) => r.getAttribute('aria-expanded')).sort(), ['true', null].sort())
  await waitFor(() => assert.ok(document.activeElement?.getAttribute('aria-expanded') === 'true'))
  done()
}, 30_000)

test('a typed path is revealed under the narrowest root that can show it', async () => {
  plumbr.vaultDiscover.mockResolvedValueOnce(
    discovery({ mounts: null, mountsNote: 'This token may not list mounts.', warnings: [] })
  )
  plumbr.vaultDiscoverList.mockImplementation(
    async ({ mount, folder }: { mount: string; folder: string }) =>
      folder === 'apps'
        ? { state: 'error', denied: true, message: 'No list permission on secret/metadata/apps.' }
        : (tree[`${mount}/${folder}`] ?? { state: 'empty' })
  )
  const at = (folder: string, secret = false): unknown => ({
    mount: { path: 'secret', description: '' },
    folder,
    secret
  })
  plumbr.vaultDiscoverMount
    .mockResolvedValueOnce(at('apps/api'))
    .mockResolvedValueOnce(at('apps'))
    .mockResolvedValueOnce(at('apps/api/staging', true))
  const done = watchKeys()
  await signIn(false)
  await screen.findByText(/may not list mounts/)
  openPath('secret/apps/api')
  await waitFor(() => item(/^staging$/))
  openPath('secret/apps') // newest root, covers everything below, but cannot be listed
  await waitFor(() => item(/No list permission on secret\/metadata\/apps/))
  openPath('secret/apps/api/staging')
  // Found inside the listable secret/apps/api root: no extra root, the row is focused.
  await waitFor(() => assert.ok(document.activeElement === item(/^staging$/)))
  assert.equal(count(/^secret\/apps\/api\/staging$/), 0)
  assert.equal(count(/^staging$/), 1)
  done()
}, 30_000)

test('folder Connect is enabled only when its listing shows a secret directly inside', async () => {
  const listing: Record<string, VaultListing> = {
    'secret/': {
      state: 'ok',
      truncated: false,
      nodes: [
        { name: 'apps', path: 'apps', kind: 'folder' },
        { name: 'broken', path: 'broken', kind: 'folder' },
        { name: 'empty', path: 'empty', kind: 'folder' },
        { name: 'ops', path: 'ops', kind: 'folder' }
      ]
    },
    'secret/apps': tree['secret/apps'], // nested folders only
    'secret/apps/api': tree['secret/apps/api'], // direct secret leaves
    'secret/empty': { state: 'empty' },
    'secret/broken': { state: 'error', denied: false, message: 'Vault unreachable' },
    'secret/ops': tree['secret/ops'] // denied
  }
  plumbr.vaultDiscoverList.mockImplementation(
    async ({ mount, folder }: { mount: string; folder: string }) =>
      listing[`${mount}/${folder}`] ?? { state: 'empty' }
  )
  await signIn()
  const connect = (): HTMLElement =>
    screen.getByRole('button', { name: /Connect folder|Connect and scan/ })
  fireEvent.click(item(/^secret/))
  await waitFor(() => item(/^ops$/))

  // Picked folder → settled state → Connect stays disabled, with the reason shown.
  const blocked: [RegExp, RegExp][] = [
    [/^empty$/, /Nothing listed directly inside \(empty, or no list permission\)/],
    [/^broken$/, /could not be listed, so it cannot be connected as a folder/],
    [/^ops$/, /could not be listed, so it cannot be connected as a folder/], // denied
    [/^apps$/, /No secrets directly inside, so it cannot be connected as a folder/] // nested only
  ]
  for (const [row, reason] of blocked) {
    fireEvent.click(item(row))
    await screen.findByText(reason)
    assert.equal(item(row).getAttribute('aria-selected'), 'true')
    assert.ok(connect().hasAttribute('disabled'), String(row))
  }

  // A folder with direct secrets can connect.
  await waitFor(() => item(/^api$/))
  fireEvent.click(item(/^api$/))
  await screen.findByText(/2 secrets directly inside become environments/)
  await waitFor(() => assert.ok(!connect().hasAttribute('disabled')))
  assert.match(connect().textContent ?? '', /Connect folder/)

  // A secret pick is always connectable.
  await waitFor(() => item(/^prod$/))
  fireEvent.click(item(/^prod$/))
  await waitFor(() => assert.match(connect().textContent ?? '', /Connect and scan/))
  assert.ok(!connect().hasAttribute('disabled'))

  // Back to a blocked folder: disabled again.
  fireEvent.click(item(/^empty$/))
  await waitFor(() => assert.ok(connect().hasAttribute('disabled')))
}, 30_000)
