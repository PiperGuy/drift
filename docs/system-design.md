# Drift (Plumbr desktop): high-level system design (local-first)

Goal: everything runs on the user's machine. No Plumbr server in the loop for any core feature, no accounts, no telemetry. Integration credentials are stored locally, encrypted with OS-backed keys. The one exception is share links, which need a small relay. That trade-off is spelled out in section 6.

## 1. Big picture

```
┌─────────────────────────────── user's machine ───────────────────────────────┐
│                                                                              │
│  Renderer (React, sandboxed)          Preload            Main (Node)         │
│  ┌──────────────────────┐   window.plumbr   ┌───────────────────────────┐   │
│  │ pages, zustand store │ ───────────────►  │ ipc.ts (zod validated)    │   │
│  │ sees: key names,     │ ◄───────────────  │ workspace.ts  discovery   │   │
│  │ classes, fingerprints│                   │ env.ts        parse+HMAC  │   │
│  └──────────────────────┘                   │ store/        SQLite      │   │
│                                             │ vault/        safeStorage │   │
│  ┌──────────────────────┐   local socket    │ providers/    adapters    │   │
│  │ MCP companion (stdio)│ ◄──────────────►  │ history/      events      │   │
│  │ used by Claude Code, │   token-authed    │ share/        seal+upload │   │
│  │ Cursor …             │                   └─────────┬─────────────────┘   │
│  └──────────────────────┘                             │                     │
│        ▲                                              │ user's own creds     │
│        │ stdio                                        ▼                     │
│  AI coding agent                     ┌──────────────────────────────────┐   │
│                                      │ .env* files in granted roots     │   │
│                                      │ ~/Library/Application Support/…  │   │
│                                      │   plumbr.db (SQLite)             │   │
│                                      │ OS keychain / DPAPI / libsecret  │   │
│                                      └──────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────────────┘
                 │ HTTPS with the user's own tokens               │ HTTPS, ciphertext only
                 ▼                                                ▼
   GitHub, Vercel, Railway, Render, Dokploy,            Share relay (Cloudflare Worker + KV)
   Coolify, AWS Secrets Manager, Vault                  the only Plumbr-operated component
```

Three processes, one trust boundary. The renderer is a sandboxed web page. The main process owns files, credentials, network and the database. Everything the renderer needs goes through `window.plumbr`, one typed function per action, validated with zod in main. Values never cross that bridge.

## 2. Process model and security boundary

| Process       | Trust                   | Owns                                                                             | Never                                                  |
| ------------- | ----------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Renderer      | untrusted (web content) | UI, view state                                                                   | file system, network, credentials, raw values          |
| Preload       | trusted, tiny           | `window.plumbr` bridge                                                           | logic, imports beyond `electron` and `shared/channels` |
| Main          | trusted                 | discovery, parsing, fingerprints, SQLite, safeStorage, provider HTTP, MCP socket | send a raw value to the renderer or a log              |
| MCP companion | semi-trusted, read-only | stdio MCP server for agents                                                      | values, sync execution                                 |

Flags already set: `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, strict CSP, external links to system browser, in-app navigation blocked, path allow-list of granted roots.

Raw values exist only inside a main-process function call: read file → parse → fingerprint or send to a provider → drop. They are not cached, not logged, not put in error messages.

## 3. Local storage: SQLite plus OS-encrypted blobs

Decision: **`node:sqlite`** (built into the Node that Electron 43 ships, SQLite 3.53, no native module to rebuild) for structured data, plus **Electron `safeStorage`** for anything secret. This is better than "just SQLite" because the database never holds a usable secret on its own, and better than "just the keychain" because keychains are bad at structured data and quotas.

Why not the alternatives:

- `better-sqlite3`: excellent, but a native module that must be rebuilt per Electron version. `node:sqlite` removes that. Swap in only if `node:sqlite` proves too slow or missing something (unlikely for our sizes).
- SQLCipher (whole-DB encryption): another native build, and it protects data we do not store in the clear anyway. Not needed while values never persist. Reconsider if we add opt-in encrypted file snapshots and want defence in depth.
- keytar: deprecated. `safeStorage` is the maintained native path (Keychain on macOS, DPAPI on Windows, libsecret or kwallet on Linux).
- electron-store / JSON files: fine for preferences, poor for history queries and integrity. We keep one small JSON for window state only.

Location: `app.getPath('userData')/plumbr.db`, WAL mode, `PRAGMA foreign_keys=ON`, migrations as numbered SQL strings applied at startup inside a transaction.

### 3.1 Schema (v1)

```sql
-- what the user granted and what discovery found
roots        (id, path UNIQUE, granted_at, last_scan_at)
projects     (id, root_id, rel_path, label, git_remote NULLABLE)     -- label editable by user
env_files    (id, project_id, path UNIQUE, name, label, mtime, size, last_seen_at)
ignore_rules (project_id, key)                                       -- default NODE_ENV

-- redacted shapes and comparisons
snapshots    (id, env_file_id, taken_at, keys_json)  -- [{key, fingerprint|null}] never values
receipts     (id, left_ref, right_ref, created_at, rows_json, counts_json)

-- integrations
connections  (id, provider, label, config_json, secret_blob BLOB, created_at, last_used_at)
             -- config_json: endpoint, region, team id, custom CA pem … (non-secret)
             -- secret_blob: safeStorage.encryptString(JSON of token/key), NULL for AWS (credential chain)
mappings     (id, env_file_id, connection_id, target_json)  -- e.g. {repo, environment} or {projectId, target:"preview", branch}

-- audit and rollback
events       (id, at, kind, actor, subject_json, redacted_detail_json)  -- append-only
             -- kinds: scan, compare, plan_created, plan_approved, apply_ok, apply_partial, apply_failed,
             --        file_written, rollback, share_created, share_revoked, connection_added, …
file_history (id, env_file_id, at, blob BLOB NULLABLE, shape_json)  -- blob = safeStorage-encrypted file bytes, opt-in only

-- shares
shares       (id, env_file_id, relay_id, created_at, expires_at, max_opens, revoked_at)
             -- the decryption key is NOT stored. It lives only in the link the user copied.

meta         (key, value)  -- schema_version, install_id, fingerprint_key_ref
```

### 3.2 Keys and secrets at rest

| Secret                                                                     | Where                                                                                  | Notes                                                                                                                                                                         |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fingerprint HMAC key                                                       | random 32 bytes at first run, `safeStorage.encryptString` → `meta.fingerprint_key_ref` | Per install, so fingerprints are stable across launches (history and receipts stay comparable) but useless off-machine. Today it is per session. Change when the store lands. |
| Provider tokens (GitHub, Vercel, Railway, Render, Dokploy, Coolify, Vault) | `connections.secret_blob` via `safeStorage`                                            | Decrypted in memory only for the duration of one provider call.                                                                                                               |
| AWS                                                                        | not stored                                                                             | Standard credential chain: profiles, SSO, env. The app only stores the profile name and region.                                                                               |
| Encrypted file snapshots (opt-in)                                          | `file_history.blob` via `safeStorage`                                                  | Off by default. Needed only for rollback of contents.                                                                                                                         |
| Share link key                                                             | nowhere                                                                                | URL fragment only.                                                                                                                                                            |

`safeStorage.isEncryptionAvailable()` false (no keyring on Linux, locked session): the app refuses to persist secrets and offers session-only connections instead. It never falls back to plaintext.

Explicit lock: an app-level lock clears in-memory decrypted material. Unlock uses OS auth (Touch ID / Windows Hello / polkit) when available, otherwise a plain confirm.

## 4. Core flows

### 4.1 Discovery (done)

Folder picker → root recorded → walk with skip list → `env_files` upsert (metadata only) → group by nearest `.git`. Rescan is user-initiated. Later: opt-in `fs.watch` on granted roots, debounced, still metadata-only.

### 4.2 Receipt (done for local files)

Two refs (file or provider mapping) → main reads both sides → parse → HMAC fingerprints → `compareEnv` → rows and counts → stored in `receipts`, shown in UI. Provider side uses the adapter's `read`.

### 4.3 Approved sync (todo)

Receipt → `planSync` → approval dialog shows exact source, exact target, per-key ops → user approves → main re-reads both sides, aborts with `changed_since_plan` if either fingerprint set moved → adapter `apply` per key → per-key result → re-read target → `verified | partial | failed` → event row. No scheduler, no bulk propagation, no auto-retry that writes.

### 4.4 Local file write (todo)

Same as 4.3 with the file adapter: write to a temp sibling, fsync, rename. Preserve comments and ordering where possible. Never overwrite a file whose mtime or shape changed since the plan.

### 4.5 History and rollback (todo)

Every action appends an event. Every compare stores a redacted snapshot. Rollback of contents is available only if the user turned on encrypted file snapshots for that project.

## 5. Provider adapters

One interface, one folder per provider in `src/main/providers/`:

```ts
interface Provider {
  id: 'github' | 'vercel' | 'railway' | 'render' | 'dokploy' | 'coolify' | 'aws-sm' | 'vault'
  test(conn): Promise<void> // auth check, no writes
  listTargets(conn): Promise<Target[]> // repos, projects, services, secrets, paths
  read(conn, target): Promise<KeyEntry[]> // names + fingerprints where values are readable
  apply(conn, target, plan): Promise<ApplyResult> // per-key outcome, only from the approval dialog
}
```

All HTTP happens in main with `fetch`. Custom CA support (Dokploy, Coolify) via `undici` `Agent` with the user-supplied PEM from `config_json`. GitHub secret writes use libsodium sealed boxes with the repository public key (`libsodium-wrappers` or `tweetnacl` + `tweetnacl-sealedbox-js`, both pure JS). AWS via `@aws-sdk/client-secrets-manager` with the default chain.

## 6. What can and cannot be fully local

### Fully local (no Plumbr server, no account)

| Feature                                                            | Why it works locally                                                                                             |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Workspace discovery, receipts, dry-run plans                       | Pure file reads and pure functions. Already done.                                                                |
| Per-environment view, ignore rules, labels                         | SQLite metadata.                                                                                                 |
| Two-way repo sync                                                  | Local file writes after approval.                                                                                |
| Local history, audit trail, rollback                               | SQLite `events` and `file_history`, encrypted blobs opt-in.                                                      |
| Platform sync to GitHub, Vercel, Railway, Render, Dokploy, Coolify | The app calls each provider's public API with the user's own token from the user's machine. No Plumbr middleman. |
| AWS Secrets Manager, Vault KV v2                                   | Same, using the local AWS credential chain or a Vault token.                                                     |
| Credential storage                                                 | `safeStorage` + SQLite. OS keychain provides the key.                                                            |
| MCP for coding agents                                              | Local stdio process talking to the app over a local socket.                                                      |
| Biometric unlock                                                   | OS APIs.                                                                                                         |
| Tray / menu-bar mode                                               | Electron `Tray`.                                                                                                 |
| Light and dark, offline use                                        | Nothing leaves the machine. Core features need no network at all.                                                |

### Needs something hosted, and the cheapest honest way to do it

| Feature                                                                      | Why not fully local                                                                                                                                                                                                                                                  | Recommended shape                                                                                                                                                                                                                                               | Cost and overhead                                                                              |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Share links (expire by time or opens, revocable, recipient needs no account) | The recipient must fetch ciphertext when the sender is offline, and "destroy after N opens" and "revoke" must be enforced by something neither party controls. Sealing stays local (AES-GCM, key in the URL fragment). Only the storage and the counter need a host. | Cloudflare Worker + KV (or R2): `PUT /s` stores ciphertext with TTL, `GET /s/:id` decrements opens and deletes at zero, `DELETE /s/:id` with a revoke token. Static recipient page decrypts in the browser. Zero servers to manage, stateless code, ~150 lines. | Free tier covers early usage. No database, no accounts, no PII (ciphertext and counters only). |
| Auto-update                                                                  | Binaries must live somewhere.                                                                                                                                                                                                                                        | GitHub Releases + electron-updater (already wired in `electron-builder.yml`).                                                                                                                                                                                   | Free. Not a server we run.                                                                     |
| Request access / waitlist                                                    | Website concern, already on Vercel + Resend.                                                                                                                                                                                                                         | Unchanged.                                                                                                                                                                                                                                                      | Existing.                                                                                      |
| Licensing (if we sell a one-time license later)                              | Issuing keys needs a payment provider. Verifying does not.                                                                                                                                                                                                           | Paddle or Lemon Squeezy issue Ed25519-signed keys, the app verifies offline.                                                                                                                                                                                    | No server of ours.                                                                             |

Alternatives for sharing that avoid a Plumbr host, and why they fall short of the site's promise: (a) upload ciphertext to the user's own GitHub gist or S3 bucket, which works but cannot enforce open counts or account-free revoke, and the recipient page still has to be served from somewhere, (b) WebRTC hand-off, which needs both people online and a signaling server anyway. If the Worker is unacceptable, the website copy for sharing has to soften to "sealed link, time-limited" and drop open counts and revoke.

### Deliberately not offered

Team RBAC, org-wide audit, hosted source of truth, scheduled sync, telemetry. These are exactly the things that would need a backend and an account, and the site positions Plumbr Env against them.

## 7. MCP companion

`plumbr-mcp` binary bundled with the app (or `npx plumbr-mcp`), stdio transport via `@modelcontextprotocol/sdk`. It connects to the running app over a local socket (`\\.\pipe\plumbr` on Windows, `$XDG_RUNTIME_DIR/plumbr.sock` or userData on macOS/Linux) with a per-install token the app writes to a 0600 file. Tools: `list_projects`, `list_env_files`, `compare_environment`, `get_drift_summary`, `create_sync_plan`. No `get_secret`, no file read, no shell, no apply. If the app is not running the companion returns a clear "open Plumbr Env" error.

## 8. Threat model in one paragraph

Protects against: leaking values into chat, logs, receipts, screenshots, agent context, crash reports, and against a compromised renderer reading files or credentials. Also against a lost laptop where the OS keychain is locked (secrets are ciphertext, values are not stored). Does not protect against: malware running as the user while the session is unlocked, a malicious `.env` file trying to exploit the parser (parser is a small regex state machine, fuzz it), or a compromised provider token being used elsewhere. Same honest baseline JustEnvs documents.

## 9. Open decisions

1. Fingerprint key: move from per-session to per-install (needs the store). Yes, do it with milestone 1 persistence.
2. Encrypted file snapshots for rollback: opt-in per project. Default off.
3. Share relay: Cloudflare Worker + KV, hosted under theplumbr.com (`share.theplumbr.com` is already the placeholder on the site). Needs a go from the user, since it is the one hosted piece.
4. Linux without a keyring: session-only connections, never plaintext. Confirm this is acceptable UX.
5. Provider order: GitHub and Vercel first (site marks them Popular), then Railway/Render, then Dokploy/Coolify, then AWS/Vault. AWS/Vault are the ones the earlier plan wanted first for validation, so pick based on the first design partners.
