import { afterAll } from 'vitest'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Shared scaffolding for provider adapter tests: fake API server + temp store. */
export type Handler = (
  req: IncomingMessage,
  url: URL,
  body: unknown,
  json: (status: number, body: unknown) => void,
  res: ServerResponse
) => void

export async function fakeApi(handler: Handler): Promise<string> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString()
      let body: unknown = null
      try {
        body = text ? JSON.parse(text) : null
      } catch {
        body = null
      }
      const url = new URL(req.url ?? '/', 'http://x')
      handler(
        req,
        url,
        body,
        (status, b) => {
          res.writeHead(status, { 'Content-Type': 'application/json' })
          res.end(typeof b === 'string' ? b : JSON.stringify(b))
        },
        res
      )
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  afterAll(() => server.close())
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`
}

export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/**
 * Make a fake container's PATH provide the GNU `stat -c` and `xargs -r`
 * contract. Docker/ECS targets are Linux, but their test doubles execute on
 * the host, whose BSD utilities use incompatible flags on macOS.
 */
export function linuxCommandShims(bin: string): void {
  const node = JSON.stringify(process.execPath)
  const writeTool = (name: string, source: string): void => {
    const path = join(bin, name)
    const program = `${path}.js`
    writeFileSync(program, source)
    writeFileSync(path, `#!/bin/sh\nexec ${node} ${JSON.stringify(program)} "$@"\n`)
    chmodSync(path, 0o755)
  }
  const writeShellTool = (name: string, source: string): void => {
    const path = join(bin, name)
    writeFileSync(path, `#!/bin/sh\n${source}\n`)
    chmodSync(path, 0o755)
  }
  writeTool(
    'stat',
    String.raw`const { statSync } = require('node:fs')
const args = process.argv.slice(2)
if (args.shift() !== '-c') process.exit(2)
const format = args.shift()
for (const path of args) {
  const s = statSync(path, { bigint: true })
  const seconds = s.mtimeNs / 1000000000n
  const nanos = (s.mtimeNs % 1000000000n).toString().padStart(9, '0')
  const date = new Date(Number(seconds) * 1000).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '')
  const stamp = date + '.' + nanos + ' +0000'
  console.log(
    format
      .replace(/%Y/g, seconds)
      .replace(/%s/g, s.size)
      .replace(/%y/g, stamp)
      .replace(/%n/g, () => path)
  )
}`
  )
  // BSD xargs accepts -0 but not GNU's -r. Preserve -0 so NUL-delimited
  // paths from find remain separate arguments, and drop only -r.
  writeShellTool(
    'xargs',
    `if [ "$1" = '-0' ]; then\n  shift\n  if [ "$1" = '-r' ]; then shift; fi\n  exec /usr/bin/xargs -0 "$@"\nfi\nif [ "$1" = '-r' ]; then shift; fi\nexec /usr/bin/xargs "$@"`
  )
}
