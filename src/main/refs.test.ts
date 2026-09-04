import { test } from 'vitest'
import assert from 'node:assert/strict'
import { dockerRef, isRemote, joinRef, parseRef, providerRef, relRef, isReadOnlyRef } from './fs'
import { grantRoot, isGranted, revokeRoots } from './workspace'
import { DockerSourceSpecSchema, ProviderConnectSpecSchema, SshRootRequest } from '@shared/ipc'

test('docker refs: local and ssh daemon, container and path parse, join and rel', () => {
  assert.deepEqual(parseRef('docker:///api-1/app'), {
    kind: 'docker',
    host: null,
    container: 'api-1',
    path: '/app'
  })
  assert.deepEqual(parseRef('docker://deploy@vps/api_1/srv/app'), {
    kind: 'docker',
    host: 'deploy@vps',
    container: 'api_1',
    path: '/srv/app'
  })
  assert.equal(dockerRef(null, 'api-1', '/app'), 'docker:///api-1/app')
  assert.equal(dockerRef('deploy@vps', 'api-1', '/'), 'docker://deploy@vps/api-1/')
  assert.equal(joinRef('docker:///api-1/app', 'web/.env'), 'docker:///api-1/app/web/.env')
  assert.equal(relRef('docker:///api-1/app', 'docker:///api-1/app/web/.env'), 'web/.env')
  assert.ok(isRemote('docker:///api-1/app'))
  assert.ok(!isReadOnlyRef('docker:///api-1/app'))
})

test('provider refs: <provider>://<connection>/<path>, read-only, join and rel', () => {
  assert.deepEqual(parseRef('vercel://7/prj_123/production'), {
    kind: 'provider',
    provider: 'vercel',
    connectionId: 7,
    path: 'prj_123/production'
  })
  assert.deepEqual(parseRef('render://3'), {
    kind: 'provider',
    provider: 'render',
    connectionId: 3,
    path: ''
  })
  assert.equal(providerRef('github', 2, 'acme/api'), 'github://2/acme/api')
  assert.equal(joinRef('render://3', 'services/srv-1/.env'), 'render://3/services/srv-1/.env')
  assert.equal(relRef('render://3', 'render://3/services/srv-1/.env'), 'services/srv-1/.env')
  assert.equal(
    relRef('github://2/acme/api', 'github://2/acme/api/.env.production'),
    '.env.production'
  )
  for (const p of ['ecs', 'aws-sm', 'vercel', 'github', 'railway', 'render', 'dokploy', 'coolify'])
    assert.ok(isReadOnlyRef(`${p}://1/x`) && isRemote(`${p}://1/x`), p)
  // Unknown schemes are not provider refs: they fall through to a local path.
  assert.equal(parseRef('gopher://1/x').kind, 'local')
  assert.ok(!isReadOnlyRef('/home/x/.env'))
  assert.ok(!isReadOnlyRef('ssh://vps/srv'))
})

test('grants: docker and provider roots gate their files like ssh roots', () => {
  revokeRoots()
  grantRoot('docker:///api-1/app/')
  grantRoot('render://3/')
  assert.ok(isGranted('docker:///api-1/app/web/.env'))
  assert.ok(!isGranted('docker:///api-2/app/web/.env'))
  assert.ok(isGranted('render://3/services/srv-1/.env'))
  assert.ok(!isGranted('render://4/services/srv-1/.env'))
  revokeRoots()
})

test('grants: remote refs with . or .. segments are never granted (used verbatim by cat/find remotely)', () => {
  revokeRoots()
  grantRoot('docker:///api-1/app')
  grantRoot('ssh://vps/srv')
  grantRoot('ecs://1/prod/service:api/api/fs/app')
  grantRoot('docker:///web-1/')
  for (const forged of [
    'docker:///api-1/app/../other/.env',
    'docker:///api-1/app/./../other/.env',
    'docker:///api-1/app/x/../../.env',
    'docker:///api-1/app/./.env',
    'ssh://vps/srv/../etc/passwd',
    'ecs://1/prod/service:api/api/fs/app/../etc/.env',
    'ecs://1/prod/service:api/api/fs/app/../../.env',
    'docker:///web-1/../.env',
    'docker:///web-1/etc/../root/.env'
  ])
    assert.ok(!isGranted(forged), forged)
  // Plain descendants still pass, including under a `/` root.
  assert.ok(isGranted('docker:///api-1/app/web/.env'))
  assert.ok(isGranted('docker:///api-1/app/..hidden/.env'))
  assert.ok(isGranted('docker:///web-1/etc/app/.env'))
  assert.ok(isGranted('ecs://1/prod/service:api/api/fs/app/svc/.env'))
  // A root itself cannot traverse either.
  assert.throws(() => grantRoot('docker:///api-1/app/../other'), /\.\./)
  assert.throws(() => grantRoot('ssh://vps/srv/./x'), /segment/)
  revokeRoots()
})

test('renderer input: root paths with . or .. segments are refused by the schemas', () => {
  for (const path of ['/app/../x', '/app/./x', '/..', '/a/..'])
    assert.throws(() => DockerSourceSpecSchema.parse({ container: 'api-1', path }), path)
  assert.throws(() => SshRootRequest.parse({ host: 'vps', path: '/srv/../etc' }))
  assert.throws(() =>
    ProviderConnectSpecSchema.parse({
      provider: 'ecs',
      name: '',
      region: 'eu-west-1',
      cluster: 'prod',
      selector: 'service:api',
      container: 'api',
      path: '/app/../etc'
    })
  )
  // `/`, plain directories and dot-prefixed names stay valid.
  DockerSourceSpecSchema.parse({ container: 'api-1', path: '/' })
  DockerSourceSpecSchema.parse({ container: 'api-1', path: '/app/.config' })
  SshRootRequest.parse({ host: 'vps', path: '/' })
  ProviderConnectSpecSchema.parse({
    provider: 'ecs',
    name: '',
    region: 'eu-west-1',
    cluster: 'prod',
    selector: 'service:api',
    container: 'api',
    path: '/'
  })
})
