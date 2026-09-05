import { connect } from 'node:net'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PRODUCT } from '@shared/product'

/**
 * Client half of src/main/bridge.ts. Reads the per-launch capability the app
 * wrote next to its database (owner-only), sends one JSON line, gets one back.
 * The token is read fresh every call so an app restart just works, and it is
 * never printed, logged or returned to an MCP client.
 */
export const APP_OFFLINE = `${PRODUCT} is not running. Open the ${PRODUCT} app (and keep it open) to use sources, compare projects or sync.`

export async function callBridge(dir: string, method: string, params: unknown): Promise<unknown> {
  let cap: { path: string; token: string }
  try {
    cap = JSON.parse(await readFile(join(dir, 'bridge.json'), 'utf8'))
  } catch {
    throw new Error(APP_OFFLINE)
  }
  const text = await new Promise<string>((resolve, reject) => {
    const s = connect(cap.path)
    let out = ''
    s.setEncoding('utf8')
    s.on('connect', () => s.write(JSON.stringify({ token: cap.token, method, params }) + '\n'))
    s.on('data', (d: string) => (out += d))
    s.on('end', () => resolve(out))
    s.on('error', (e: NodeJS.ErrnoException) =>
      reject(e.code === 'ENOENT' || e.code === 'ECONNREFUSED' ? new Error(APP_OFFLINE) : e)
    )
    // Provider round trips can be slow; a hung app should still not hang the agent forever.
    s.setTimeout(10 * 60_000, () => s.destroy(new Error(`${PRODUCT} did not answer in time.`)))
  })
  let res: { ok: boolean; result?: unknown; error?: string }
  try {
    res = JSON.parse(text)
  } catch {
    throw new Error(`${PRODUCT} sent an unreadable reply.`)
  }
  if (!res.ok) throw new Error(res.error ?? 'Request failed')
  return res.result
}
