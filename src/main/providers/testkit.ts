import { afterAll } from 'vitest'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
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
