import { test } from 'vitest'
import assert from 'node:assert/strict'
import { formatEnv, lintEnv, looksLikeSecret, viewEnv } from './env-lint'
import { parseEnv } from './env-file'

const messy = [
  '# Database',
  'DATABASE_URL = postgres://u:p@h/db  ',
  "export TOKEN='abc'",
  'GREETING=hello world',
  'TAG=v1#beta',
  'EMPTY=',
  'lowercase=1',
  'TOKEN=second',
  'MULTI="a',
  'b"',
  'what is this',
  '',
  '',
  '',
  'LAST=1'
].join('\r\n')

test('lint: finds every rule, each once, on the right line', () => {
  const rules = lintEnv(messy, { example: false }).map((i) => `${i.line}:${i.rule}`)
  assert.deepEqual(rules, [
    '1:crlf',
    '1:mixed-export',
    '2:surrounding-space',
    '2:trailing-whitespace',
    '3:duplicate-key',
    '4:unquoted-space',
    '5:unquoted-hash',
    '6:empty-value',
    '7:key-case',
    '11:invalid-line',
    '15:no-final-newline'
  ])
})

test('format: canonical spelling, same meaning, idempotent', () => {
  const out = formatEnv(messy)
  assert.equal(
    out,
    [
      '# Database',
      'DATABASE_URL=postgres://u:p@h/db',
      'export TOKEN=abc',
      'GREETING="hello world"',
      'TAG="v1#beta"',
      'EMPTY=',
      'lowercase=1',
      'TOKEN=second',
      'MULTI="a\\nb"',
      'what is this',
      '',
      'LAST=1',
      ''
    ].join('\n')
  )
  assert.deepEqual(parseEnv(out), parseEnv(messy))
  assert.equal(formatEnv(out), out)
  assert.equal(formatEnv(''), '')
})

test('view: typed lines, masks by length, no value fragment anywhere', () => {
  const v = viewEnv(messy)
  const json = JSON.stringify(v)
  for (const leak of ['postgres', 'abc', 'hello', 'beta', 'second'])
    assert.ok(!json.includes(leak), leak)
  const db = v.lines[1]
  assert.equal(db.kind, 'assign')
  if (db.kind === 'assign') {
    assert.equal(db.key, 'DATABASE_URL')
    assert.equal(db.length, 'postgres://u:p@h/db'.length)
    assert.equal(db.mask.length, 19)
    assert.equal(db.quote, null)
  }
  const tok = v.lines[2]
  if (tok.kind === 'assign') {
    assert.equal(tok.export, true)
    assert.equal(tok.quote, "'")
    assert.equal(tok.shadowed, true)
  }
  const multi = v.lines[8]
  if (multi.kind === 'assign') assert.equal(multi.multiline, true)
  assert.equal(v.lines[9].kind, 'invalid')
  assert.equal(v.formatted, false)
  assert.equal(viewEnv('A=1\n').formatted, true)
})

test('secret-in-example fires only for credential-shaped values under secret-ish keys', () => {
  assert.ok(looksLikeSecret('sk_live_4eC39HqLyjWDarjtT1zdp7dc'))
  assert.ok(!looksLikeSecret('your-api-key-here'))
  assert.ok(!looksLikeSecret('changeme'))
  const rules = lintEnv(
    'STRIPE_SECRET_KEY=sk_live_4eC39HqLyjWDarjtT1zdp7dc\nAPP_NAME=sk_live_4eC39HqLyjWDarjtT1zdp7dc\n',
    {
      example: true
    }
  ).map((i) => i.rule)
  assert.deepEqual(rules, ['secret-in-example'])
})

test('format keeps escaped quotes, comments after quoted values, and never leaks invalid lines', () => {
  const src =
    'CONFIG="{\\"enabled\\":true}"\nTOKEN="v" # rotation note\nsk_live_4eC39HqLyjWDarjtT1zdp7dc\n'
  const out = formatEnv(src)
  // Escaped quotes survive, the comment survives, and a quote that is not needed is dropped.
  assert.equal(
    out,
    'CONFIG="{\\"enabled\\":true}"\nTOKEN=v # rotation note\nsk_live_4eC39HqLyjWDarjtT1zdp7dc\n'
  )
  assert.deepEqual(parseEnv(out), parseEnv(src))
  const v = viewEnv(src)
  assert.ok(!JSON.stringify(v).includes('sk_live'))
  assert.ok(!JSON.stringify(v).includes('enabled'))
  assert.equal(v.lines[2].kind, 'invalid')
  if (v.lines[1].kind === 'assign') assert.equal(v.lines[1].comment, '# rotation note')
  // Quoted credentials in example files are caught too.
  assert.deepEqual(
    lintEnv('STRIPE_SECRET_KEY="sk_live_4eC39HqLyjWDarjtT1zdp7dc"\n', { example: true }).map(
      (i) => i.rule
    ),
    ['secret-in-example']
  )
})
