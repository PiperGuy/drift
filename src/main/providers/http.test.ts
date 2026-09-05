import { test, afterAll } from 'vitest'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { apiRequest, expectJson, ProviderError, paginate } from './http'

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  const send = (status: number, body: string, headers: Record<string, string> = {}): void => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
    res.end(body)
  }
  if (url.pathname === '/echo') {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () =>
      send(
        200,
        JSON.stringify({
          auth: req.headers['authorization'],
          ua: req.headers['user-agent'],
          q: url.search,
          body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null
        })
      )
    )
    return
  }
  if (url.pathname === '/401') return send(401, '{"message":"Bad credentials"}')
  if (url.pathname === '/403') return send(403, '{"message":"Resource not accessible"}')
  if (url.pathname === '/404') return send(404, '{"message":"Not Found"}')
  if (url.pathname === '/429') return send(429, '{"message":"slow down"}', { 'retry-after': '7' })
  if (url.pathname === '/500') return send(500, 'oops not json')
  if (url.pathname === '/html') return send(200, '<html>login</html>')
  if (url.pathname === '/slow') return void setTimeout(() => send(200, '{}'), 400)
  if (url.pathname === '/page') {
    const p = Number(url.searchParams.get('page') ?? 1)
    return send(200, JSON.stringify({ items: p <= 3 ? [`i${p}`] : [], next: p < 3 ? p + 1 : null }))
  }
  send(404, '{}')
})
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
afterAll(() => server.close())

const cfg = { baseUrl: base, headers: { Authorization: 'Bearer unit-test-token' } }

test('apiRequest: headers, query and JSON body reach the server; JSON comes back parsed', async () => {
  const r = await apiRequest(cfg, {
    method: 'POST',
    path: '/echo',
    query: { teamId: 'team_1', empty: undefined },
    body: { a: 1 }
  })
  assert.equal(r.status, 200)
  assert.deepEqual(r.json, {
    auth: 'Bearer unit-test-token',
    ua: 'Drift/0.0.0',
    q: '?teamId=team_1',
    body: { a: 1 }
  })
})

test('expectJson: every failure branch is a typed, value-safe ProviderError', async () => {
  const at = async (path: string): Promise<ProviderError> => {
    try {
      expectJson(await apiRequest(cfg, { method: 'GET', path }), 'Acme read')
    } catch (e) {
      return e as ProviderError
    }
    throw new Error('did not throw')
  }
  const e401 = await at('/401')
  assert.equal(e401.kind, 'unauthorized')
  assert.match(e401.message, /Acme read: .*401/)
  assert.ok(!e401.message.includes('unit-test-token'))
  assert.equal((await at('/403')).kind, 'forbidden')
  assert.equal((await at('/404')).kind, 'not-found')
  const e429 = await at('/429')
  assert.equal(e429.kind, 'rate-limit')
  assert.match(e429.message, /7 s/)
  const e500 = await at('/500')
  assert.equal(e500.kind, 'http')
  assert.match(e500.message, /500/)
  const html = await at('/html')
  assert.equal(html.kind, 'malformed')
})

test('apiRequest: timeout and unreachable host are network errors naming the host only', async () => {
  await assert.rejects(
    apiRequest(cfg, { method: 'GET', path: '/slow', timeoutMs: 50 }),
    (e: ProviderError) => e.kind === 'timeout' && /127\.0\.0\.1/.test(e.message)
  )
  await assert.rejects(
    apiRequest({ ...cfg, baseUrl: 'http://127.0.0.1:1' }, { method: 'GET', path: '/x' }),
    (e: ProviderError) => e.kind === 'network'
  )
  await assert.rejects(
    apiRequest({ ...cfg, baseUrl: 'http://example.com' }, { method: 'GET', path: '/x' }),
    (e: ProviderError) => e.kind === 'config' && /https/.test(e.message)
  )
})

test('paginate: follows the cursor until it runs out, capped', async () => {
  const items = await paginate<string, number>(1, async (page) => {
    const r = expectJson(
      await apiRequest(cfg, { method: 'GET', path: '/page', query: { page: String(page) } }),
      'page'
    ) as { items: string[]; next: number | null }
    return { items: r.items, next: r.next }
  })
  assert.deepEqual(items, ['i1', 'i2', 'i3'])
  // A cursor left over at the cap is refused, never returned as a complete list.
  await assert.rejects(
    paginate<string, number>(1, async (page) => ({ items: [`p${page}`], next: page + 1 }), 3),
    (e: ProviderError) =>
      e.kind === 'limit' && /more than 3 pages/.test(e.message) && !e.message.includes('p1')
  )
  // Exactly at the cap with nothing left is fine.
  assert.deepEqual(
    await paginate<string, number>(
      1,
      async (page) => ({ items: [`p${page}`], next: page < 3 ? page + 1 : null }),
      3
    ),
    ['p1', 'p2', 'p3']
  )
})
