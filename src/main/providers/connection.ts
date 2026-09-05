import { safeStorage } from 'electron'
import type { Store, ConnectionRow } from '../store'
import { parseRef } from '../fs'

/**
 * Provider connections share one pattern with Vault: the non-secret config goes
 * to `connections.config_json`, the credential lives in this main-process Map
 * for the session and, only with the user's opt-in and a working OS keyring, in
 * `connections.secret_blob` sealed by safeStorage. AWS connections carry no
 * secret at all (credential chain). Nothing here is ever logged or returned.
 */
const secrets = new Map<number, string>()

export const NEEDS_REAUTH = (provider: string): string =>
  `This ${provider} source needs sign-in again: open Update source and re-enter the token.`

export function saveConnection(
  store: Store,
  provider: string,
  label: string,
  config: Record<string, unknown>,
  secret: string | null,
  storage: 'session' | 'keychain'
): { id: number; storage: 'session' | 'keychain'; warning: string | null } {
  const keychain = storage === 'keychain' && secret !== null && safeStorage.isEncryptionAvailable()
  const id = store.addConnection(
    provider,
    label,
    { ...config, storage: keychain ? 'keychain' : 'session' },
    keychain ? safeStorage.encryptString(JSON.stringify({ token: secret })) : null
  )
  if (secret !== null) secrets.set(id, secret)
  return {
    id,
    storage: keychain ? 'keychain' : 'session',
    warning:
      storage === 'keychain' && !keychain && secret !== null
        ? 'No OS keyring is available; the token is kept for this session only.'
        : null
  }
}

export function connectionFor(store: Store, id: number, provider: string): ConnectionRow {
  const conn = store.getConnection(id)
  if (!conn || conn.provider !== provider)
    throw new Error(
      `This ${provider} connection no longer exists. Remove the source and add it again.`
    )
  store.touchConnection(id)
  return conn
}

/** The session token, unsealing the keyring copy once if there is one. */
export function secretFor(store: Store, id: number, provider: string): string {
  const conn = connectionFor(store, id, provider)
  let token = secrets.get(id)
  if (!token && conn.secretBlob && safeStorage.isEncryptionAvailable()) {
    try {
      token = (JSON.parse(safeStorage.decryptString(conn.secretBlob)) as { token?: string }).token
      if (token) secrets.set(id, token)
    } catch {
      // Keyring changed or blob copied from another machine: fall through to re-auth.
    }
  }
  if (!token) throw new Error(NEEDS_REAUTH(provider))
  return token
}

/** Forget in-memory secrets for removed connections (bulk forget/delete paths). */
export function dropSecrets(connectionIds: number[]): void {
  for (const id of connectionIds) secrets.delete(id)
}

/** Drop the connection row and the in-memory secret behind a provider root. */
export function forgetProviderConnection(store: Store, ref: string): void {
  const r = parseRef(ref)
  if (r.kind !== 'provider') return
  secrets.delete(r.connectionId)
  store.deleteConnection(r.connectionId)
}
