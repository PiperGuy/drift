import { test } from 'vitest'
import assert from 'node:assert/strict'
import { OPAQUE_BACKGROUND, platformWindowOptions } from './window'

test('macOS: native vibrancy behind a translucent window, native chrome kept', () => {
  const mac = platformWindowOptions('darwin')
  assert.equal(mac.vibrancy, 'under-window')
  assert.equal(mac.visualEffectState, 'followWindow')
  // Any backgroundColor (even #00000000) is propagated to the web contents
  // instead of the transparency that vibrancy gives them, hiding the glass.
  assert.ok(!('backgroundColor' in mac))
  // Not needed for vibrancy, and it would drop the native shadow and resizing.
  assert.ok(!('transparent' in mac))
  assert.equal(mac.titleBarStyle, 'hiddenInset') // real traffic lights, never drawn ones
})

test('Linux and Windows: opaque fallback, no vibrancy or transparency', () => {
  for (const platform of ['linux', 'win32'] as const) {
    const o = platformWindowOptions(platform)
    assert.equal(o.backgroundColor, OPAQUE_BACKGROUND, platform)
    assert.ok(!('vibrancy' in o) && !('transparent' in o), platform)
    assert.equal(o.titleBarStyle, 'default', platform)
  }
})
