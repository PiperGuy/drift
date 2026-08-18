import { expect, test } from 'vitest'
import { ENV_FILE, parseEnv } from './env-file'

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
