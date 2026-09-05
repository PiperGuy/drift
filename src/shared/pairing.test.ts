import { test } from 'vitest'
import assert from 'node:assert/strict'
import { envIdentity, pairFiles } from './pairing'
import type { EnvFileInfo } from './channels'

const f = (root: string, rel: string, project: string | null): EnvFileInfo => ({
  path: `${root}/${rel}`,
  root,
  rel,
  name: rel.split('/').pop()!,
  project,
  modifiedAt: 0,
  size: 0
})

test('envIdentity strips the project directory, provider labels and nothing else', () => {
  // Local: project directory prefixes the relative path.
  assert.equal(envIdentity('apps/api/.env.production', 'apps/api'), '.env.production')
  assert.equal(envIdentity('.env', '.'), '.env')
  assert.equal(envIdentity('tools/.env', null), 'tools/.env')
  // Railway: project is "<project>/<service>", rel is "<service>/.env.<env>".
  assert.equal(envIdentity('web/.env.production', 'proj/web'), '.env.production')
  // Render: "services/<name>/.env" under project "services/<name>".
  assert.equal(envIdentity('services/api/.env', 'services/api'), '.env')
  // GitHub / Vercel: the project is a label that never prefixes the path.
  assert.equal(envIdentity('.env.production', 'acme/api'), '.env.production')
  assert.equal(envIdentity('branches/feat/.env.preview', 'site'), 'branches/feat/.env.preview')
  // A partial segment match is not a prefix.
  assert.equal(envIdentity('apiary/.env', 'api'), 'apiary/.env')
})

test('pairFiles pairs by identity only, lists one-sided files, refuses ambiguous pairs', () => {
  const a = [
    f('/a', 'api/.env', 'api'),
    f('/a', 'api/.env.production', 'api'),
    f('/a', 'api/.env.staging', 'api')
  ]
  const b = [
    f('vercel://1/prj', '.env.production', 'site'),
    f('vercel://1/prj', '.env.preview', 'site'),
    f('vercel://1/prj', '.env.development', 'site')
  ]
  const r = pairFiles(a, b)
  assert.deepEqual(
    r.pairs.map((p) => [p.id, p.left.rel, p.right.rel]),
    [['.env.production', 'api/.env.production', '.env.production']]
  )
  assert.deepEqual(
    r.onlyLeft.map((x) => x.rel),
    ['api/.env', 'api/.env.staging']
  )
  assert.deepEqual(
    r.onlyRight.map((x) => x.rel),
    ['.env.development', '.env.preview']
  )
  // Two ungrouped files that collapse to the same identity are never paired silently.
  const dupA = [f('/a', 'x/.env', 'x'), f('/a', 'y/.env', 'y')]
  const dupB = [f('/b', '.env', '.')]
  const d = pairFiles(dupA, dupB)
  assert.equal(d.pairs.length, 0)
  // The B file is not "only in B": it is unpaired because A is ambiguous, and says so.
  assert.deepEqual(
    d.ambiguous.map((x) => x.rel),
    ['.env', 'x/.env', 'y/.env']
  )
  assert.deepEqual(d.onlyRight, [])
})
