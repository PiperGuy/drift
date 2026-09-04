import { request as httpsRequest, Agent as HttpsAgent } from 'node:https'
import { request as httpRequest } from 'node:http'
import { app } from 'electron'
import { assertAddress } from './vault/client'

/**
 * Minimal JSON-over-HTTPS client shared by the API providers (Vercel, GitHub,
 * Railway, Render, Dokploy, Coolify). Same discipline as the Vault client:
 * plain node:https so a custom CA works, and never a token, URL or body in an
 * error or a log. Errors are typed so adapters can explain each branch.
 */

export type ApiConfig = {
  /** https://… (plain http only on loopback, for tests and local proxies). */
  baseUrl: string
  /** Auth and provider headers. Held only for the duration of one call. */
  headers: Record<string, string>
  /** PEM bundle for self-signed instances (Dokploy, Coolify). Not a secret. */
  caPem?: string
}

export type ApiResponse = {
  status: number
  json: unknown
  text: string
  headers: Record<string, string | string[] | undefined>
}

export type ProviderErrorKind =
  | 'config'
  | 'network'
  | 'timeout'
  | 'unauthorized'
  | 'forbidden'
  | 'not-found'
  | 'rate-limit'
  | 'malformed'
  | 'limit'
  | 'http'

export class ProviderError extends Error {
  constructor(
    public kind: ProviderErrorKind,
    message: string
  ) {
    super(message)
  }
}

export const userAgent = (): string =>
  `Drift/${typeof app?.getVersion === 'function' ? app.getVersion() : '0.0.0'}`

export async function apiRequest(
  cfg: ApiConfig,
  opts: {
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
    path: string
    query?: Record<string, string | undefined>
    body?: unknown
    timeoutMs?: number
  }
): Promise<ApiResponse> {
  let base: URL
  try {
    base = assertAddress(cfg.baseUrl)
  } catch (e) {
    throw new ProviderError('config', e instanceof Error ? e.message : String(e))
  }
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': userAgent(),
    ...cfg.headers
  }
  let payload: Buffer | null = null
  if (opts.body !== undefined) {
    payload = Buffer.from(JSON.stringify(opts.body), 'utf8')
    headers['Content-Type'] = 'application/json'
    headers['Content-Length'] = String(payload.length)
  }
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) qs.set(k, v)
  const search = qs.size ? `?${qs}` : ''
  const path = (base.pathname === '/' ? '' : base.pathname.replace(/\/+$/, '')) + opts.path + search

  return new Promise<ApiResponse>((resolvePromise, reject) => {
    const common = {
      method: opts.method,
      host: base.hostname,
      port: base.port || (base.protocol === 'https:' ? 443 : 80),
      path,
      headers,
      timeout: opts.timeoutMs ?? 30_000
    }
    const req =
      base.protocol === 'https:'
        ? httpsRequest({ ...common, agent: new HttpsAgent({ ca: cfg.caPem || undefined }) })
        : httpRequest(common)
    let timedOut = false
    req.on('timeout', () => {
      timedOut = true
      req.destroy(new Error('timed out'))
    })
    req.on('error', (e) =>
      reject(
        timedOut
          ? new ProviderError(
              'timeout',
              `${base.host} did not answer within ${common.timeout / 1000} s`
            )
          : new ProviderError('network', `${base.host} unreachable: ${e.message}`)
      )
    )
    req.on('response', (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json: unknown = null
        try {
          json = text ? JSON.parse(text) : null
        } catch {
          json = null
        }
        resolvePromise({ status: res.statusCode ?? 0, json, text, headers: res.headers })
      })
    })
    if (payload) req.write(payload)
    req.end()
  })
}

/** Provider error text when it is a short message field; never the raw body. */
const detail = (r: ApiResponse): string => {
  const j = r.json as Record<string, unknown> | null
  const m = j?.['message'] ?? j?.['error'] ?? (j?.['errors'] as unknown[] | undefined)?.[0]
  const s =
    typeof m === 'string'
      ? m
      : typeof m === 'object' && m
        ? String((m as { message?: string }).message ?? '')
        : ''
  return s ? ` — ${s.slice(0, 200)}` : ''
}

/** Map an HTTP status to a typed error, or return the parsed JSON body. */
export function expectJson(r: ApiResponse, context: string): unknown {
  if (r.status === 401)
    throw new ProviderError(
      'unauthorized',
      `${context}: unauthorized (HTTP 401)${detail(r)}. Check the token.`
    )
  if (r.status === 403)
    throw new ProviderError(
      'forbidden',
      `${context}: forbidden (HTTP 403)${detail(r)}. The token lacks the needed scope.`
    )
  if (r.status === 404)
    throw new ProviderError(
      'not-found',
      `${context}: not found (HTTP 404)${detail(r)}. Check the name or id.`
    )
  if (r.status === 429) {
    const after = Number(r.headers['retry-after'])
    throw new ProviderError(
      'rate-limit',
      `${context}: rate limited (HTTP 429). Try again${Number.isFinite(after) && after > 0 ? ` in ${after} s` : ' later'}.`
    )
  }
  if (r.status < 200 || r.status >= 300)
    throw new ProviderError('http', `${context}: HTTP ${r.status}${detail(r)}`)
  if (r.json === null && r.text.trim() !== '')
    throw new ProviderError(
      'malformed',
      `${context}: the response was not JSON (is this the API URL?)`
    )
  return r.json
}

/**
 * Follow a cursor/page until it runs out. Capped so a huge account cannot spin
 * forever; a cursor still pending at the cap is an error, never a partial list
 * presented as complete.
 */
export async function paginate<T, C>(
  first: C,
  page: (cursor: C) => Promise<{ items: T[]; next: C | null | undefined }>,
  maxPages = 50
): Promise<T[]> {
  const out: T[] = []
  let cursor: C | null | undefined = first
  // The first page always runs, even when its cursor is undefined.
  for (let i = 0; i === 0 || (cursor !== null && cursor !== undefined); i++) {
    if (i >= maxPages)
      throw new ProviderError(
        'limit',
        `The listing has more than ${maxPages} pages; narrow the source (a project, environment or prefix) so the scan can be complete.`
      )
    const r = await page(cursor as C)
    out.push(...r.items)
    cursor = r.next
  }
  return out
}
