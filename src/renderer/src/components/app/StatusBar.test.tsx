// @vitest-environment jsdom
import { afterEach, beforeEach, test, vi } from 'vitest'
import assert from 'node:assert/strict'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import type { PlumbrApi } from '@shared/channels'
import { StatusBar } from './StatusBar'

const plumbr = {
  appInfo: vi.fn(async () => ({
    version: '0.3.0',
    platform: 'darwin',
    electron: '43.0.0',
    node: '24.0.0',
    chrome: '1',
    dataPath: '/tmp/plumbr.db',
    keyPersisted: false,
    mcp: { command: '/app/Drift', args: [], env: {} }
  }))
} as unknown as PlumbrApi

beforeEach(() => {
  window.plumbr = plumbr
})
afterEach(cleanup)

// Regression: the version must come from the packaged app (app.getVersion, via
// the appInfo IPC call) and render somewhere always visible, not a hardcoded string.
test('status bar shows the packaged app version once appInfo resolves', async () => {
  render(<StatusBar />)
  await waitFor(() => assert.ok(screen.getByText('v0.3.0')))
})
