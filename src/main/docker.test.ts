import { test, afterAll } from 'vitest'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  checkDockerRoot,
  dockerArgs,
  dockerContainers,
  dockerExec,
  dockerRef,
  readText,
  scanRoot,
  statRef,
  writeAtomic
} from './fs'
import { envShape, revealValue } from './env'
import { grantRoot } from './workspace'
import { linuxCommandShims } from './providers/testkit'

/**
 * A fake `docker` on PATH: `exec api-1 sh -c <script>` runs the script locally
 * (the "container" is a temp dir), any other container name fails like the
 * daemon does, and every invocation's argv is logged so the test can assert
 * that Drift never builds a shell string.
 */
const dir = mkdtempSync(join(tmpdir(), 'drift-docker-'))
const bin = join(dir, 'bin')
mkdirSync(bin)
linuxCommandShims(bin)
const log = join(dir, 'argv.log')
writeFileSync(
  join(bin, 'docker'),
  `#!/bin/sh
printf '%s\\n' "$@" >> ${JSON.stringify(log)}
printf '%s\\n' -- >> ${JSON.stringify(log)}
if [ "$1" = "-H" ]; then shift 2; fi
if [ "$1" = "ps" ]; then printf 'web-1\\napi-1\\n'; exit 0; fi
[ "$1" = "exec" ] || { echo "unexpected: $*" >&2; exit 2; }
[ "$2" = "api-1" ] || { echo "Error response from daemon: No such container: $2" >&2; exit 1; }
exec sh -c "$5"
`
)
chmodSync(join(bin, 'docker'), 0o755)
const oldPath = process.env['PATH']
process.env['PATH'] = `${bin}:${oldPath}`
afterAll(() => {
  process.env['PATH'] = oldPath
  rmSync(dir, { recursive: true, force: true })
})

const app = join(dir, 'app')
mkdirSync(join(app, 'api', '.git'), { recursive: true })
mkdirSync(join(app, 'node_modules', 'x'), { recursive: true })
writeFileSync(join(app, 'api', '.env'), 'A=1\n')
writeFileSync(join(app, 'api', '.env.production'), 'A=2\nB="x y"\n')
writeFileSync(join(app, '$&.env'), 'DOLLAR=1\n')
writeFileSync(join(app, 'node_modules', 'x', '.env'), 'SKIP=1\n')

test('dockerArgs: argument array, -H ssh://host only for a remote daemon', () => {
  assert.deepEqual(dockerArgs(null, 'api-1', 'cat /x'), ['exec', 'api-1', 'sh', '-c', 'cat /x'])
  assert.deepEqual(dockerArgs('deploy@vps', 'api-1', 'cat /x'), [
    '-H',
    'ssh://deploy@vps',
    'exec',
    'api-1',
    'sh',
    '-c',
    'cat /x'
  ])
})

test('docker fake container preserves every NUL-delimited pathname passed from xargs to stat', async () => {
  const out = await dockerExec(
    null,
    'api-1',
    `cd ${JSON.stringify(app)}; printf './api/.env\\0./api/.env.production\\0./$&.env\\0' | xargs -0 -r stat -c '%Y %s %y %n'`
  )
  assert.deepEqual(
    out
      .trim()
      .split('\n')
      .map((line) => line.split(' ').at(-1)),
    ['./api/.env', './api/.env.production', './$&.env']
  )
})

test('docker: scan, read, stat and atomic write go through docker exec', async () => {
  const root = dockerRef(null, 'api-1', app)
  await checkDockerRoot(null, 'api-1', app)
  const scan = await scanRoot(root)
  assert.deepEqual(
    scan.files.map((f) => [f.rel, f.project]),
    [
      ['api/.env', 'api'],
      ['api/.env.production', 'api']
    ]
  )
  assert.equal(scan.files[0].path, dockerRef(null, 'api-1', join(app, 'api/.env')))
  assert.equal(await readText(scan.files[1].path), 'A=2\nB="x y"\n')
  const st = await statRef(scan.files[0].path)
  assert.equal(st.size, 4)
  await writeAtomic(scan.files[0].path, "A=1\nC='new'\n")
  assert.equal(readFileSync(join(app, 'api', '.env'), 'utf8'), "A=1\nC='new'\n")
  // A path with a quote is passed through intact (quoted for the remote sh, never interpolated).
  mkdirSync(join(app, "it's"), { recursive: true })
  writeFileSync(join(app, "it's", '.env'), 'Q=1\n')
  assert.equal(await readText(dockerRef(null, 'api-1', join(app, "it's", '.env'))), 'Q=1\n')
  // argv log: every call was `exec api-1 sh -c <script>`; a remote host adds -H.
  const calls = readFileSync(log, 'utf8').split('--\n').filter(Boolean)
  assert.ok(calls.length >= 5)
  for (const c of calls) assert.match(c, /^exec\napi-1\nsh\n-c\n/)
})

test('docker: remote daemon host is passed with -H, names are listed with ps', async () => {
  assert.deepEqual(await dockerContainers('deploy@vps'), ['api-1', 'web-1'])
  const calls = readFileSync(log, 'utf8').split('--\n').filter(Boolean)
  assert.match(calls.at(-1)!, /^-H\nssh:\/\/deploy@vps\nps\n/)
})

test('docker: a missing container fails with the daemon message and a hint', async () => {
  await assert.rejects(
    readText(dockerRef(null, 'nope', join(app, 'api/.env'))),
    /No such container: nope.*docker ps/
  )
  await assert.rejects(checkDockerRoot(null, 'api-1', join(app, 'missing')), /not a directory/)
})

test('docker: a forged renderer ref cannot cat outside the granted directory', async () => {
  mkdirSync(join(dir, 'outside'), { recursive: true })
  writeFileSync(join(dir, 'outside', '.env'), 'LEAK=1\n')
  const root = dockerRef(null, 'api-1', app)
  grantRoot(root)
  const before = readFileSync(log, 'utf8')
  for (const forged of [
    `${root}/../outside/.env`,
    `${root}/api/../../outside/.env`,
    `${root}/./../outside/.env`
  ]) {
    await assert.rejects(envShape(forged), /outside every granted workspace root/)
    await assert.rejects(revealValue(forged, 'LEAK'), /outside every granted workspace root/)
  }
  // Nothing reached docker exec for those paths.
  assert.equal(readFileSync(log, 'utf8'), before)
  // The honest path under the root still reads.
  assert.ok((await envShape(`${root}/api/.env`)).entries.length > 0)
})
