import { expect, test } from 'vitest'
import assert from 'node:assert/strict'
import { ENV_FILE, parseEnv, patchEnv, rawAssignment } from './env-file'

test('parses keys, quotes, exports, comments and blanks', () => {
  const text = [
    '# comment',
    'A=1',
    'export B="two words" # trailing',
    "C='single'",
    'D=raw value # comment',
    'E=',
    'BAD LINE',
    'F="multi',
    'line"',
    'G=`tick`'
  ].join('\n')
  expect(parseEnv(text)).toEqual([
    { key: 'A', value: '1' },
    { key: 'B', value: 'two words' },
    { key: 'C', value: 'single' },
    { key: 'D', value: 'raw value' },
    { key: 'E', value: '' },
    { key: 'F', value: 'multi\nline' },
    { key: 'G', value: 'tick' }
  ])
})

test('ENV_FILE matches .env variants only', () => {
  for (const ok of ['.env', '.env.local', '.env.production', '.env.staging.local'])
    expect(ENV_FILE.test(ok)).toBe(true)
  for (const no of ['env', '.envrc', '.environment', 'foo.env'])
    expect(ENV_FILE.test(no)).toBe(false)
})

test('patchEnv: replaces the last assignment in place, appends new keys, keeps everything else', () => {
  const src = '# db\nDATABASE_URL=old\nexport TOKEN="a\nb"\nTOKEN=second # wins\n\nKEEP=1\n'
  assert.equal(rawAssignment(src, 'TOKEN'), 'TOKEN=second # wins')
  assert.equal(rawAssignment(src, 'NOPE'), null)
  const out = patchEnv(src, [
    { key: 'TOKEN', text: 'TOKEN="new"' },
    { key: 'DATABASE_URL', text: 'DATABASE_URL=postgres://x' },
    { key: 'ADDED', text: 'ADDED=1' }
  ])
  assert.equal(
    out,
    '# db\nDATABASE_URL=postgres://x\nexport TOKEN="a\nb"\nTOKEN="new"\n\nKEEP=1\nADDED=1\n'
  )
  // Parse agrees with what a reader would see.
  assert.deepEqual(
    parseEnv(out).map((e) => `${e.key}=${e.value}`),
    ['DATABASE_URL=postgres://x', 'TOKEN=a\nb', 'TOKEN=new', 'KEEP=1', 'ADDED=1']
  )
  // CRLF files stay CRLF.
  assert.equal(patchEnv('A=1\r\n', [{ key: 'B', text: 'B=2' }]), 'A=1\r\nB=2\r\n')
})
