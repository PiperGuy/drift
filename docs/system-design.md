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

| Process       | Trust                   | Owns                                                                                | Never                                                  |
| ------------- | ----------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Renderer      | untrusted (web content) | UI, view state                                                                      | file system, network, credentials, raw values          |
| Preload       | trusted, tiny           | `window.plumbr` bridge                                                              | logic, imports beyond `electron` and `shared/channels` |
| Main          | trusted                 | discovery, parsing, fingerprints, SQLite, safeStorage, provider HTTP, MCP socket    | send a raw value to the renderer or a log              |
| MCP companion | semi-trusted            | stdio MCP server for agents; relays source/plan/apply calls to main over the bridge | values, credentials, its own writes                    |

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
receipts     (id, left_ref, right_ref, created_at, rows_json, counts_json, guard)
             -- guard: sha256 of both redacted shapes at compare time; an apply quotes the receipt id and
             --        main refuses when either side's shape moved since (the plan is the contract)

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

| Secret                                                                     | Where                                                                                   | Notes                                                                                                                                                                         |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fingerprint HMAC key                                                       | random 32 bytes at first run, `safeStorage.encryptString` → `meta.fingerprint_key_ref`  | Per install, so fingerprints are stable across launches (history and receipts stay comparable) but useless off-machine. Today it is per session. Change when the store lands. |
| Provider tokens (GitHub, Vercel, Railway, Render, Dokploy, Coolify, Vault) | main-process Map for the session; `connections.secret_blob` via `safeStorage` on opt-in | Session-only by default. Sealed only when the user ticks the keyring box and `safeStorage` is available. Dropped with the source, the workspace or Forget data.               |
| AWS                                                                        | not stored                                                                              | Standard credential chain: profiles, SSO, env. The app only stores the profile name and region.                                                                               |
| Encrypted file snapshots (opt-in)                                          | `file_history.blob` via `safeStorage`                                                   | Off by default. Needed only for rollback of contents.                                                                                                                         |
| Share link key                                                             | nowhere                                                                                 | URL fragment only.                                                                                                                                                            |

`safeStorage.isEncryptionAvailable()` false (no keyring on Linux, locked session): the app refuses to persist secrets and offers session-only connections instead. It never falls back to plaintext.

Explicit lock: an app-level lock clears in-memory decrypted material. Unlock uses OS auth (Touch ID / Windows Hello / polkit) when available, otherwise a plain confirm.

## 4. Core flows

### 4.1 Discovery (done)

Folder picker → root recorded → walk with skip list → `env_files` upsert (metadata only) → group by nearest `.git`. Rescan is user-initiated. Later: opt-in `fs.watch` on granted roots, debounced, still metadata-only.

### 4.2 Receipt (done)

Two refs (any two sources) → main reads both sides → parse → HMAC fingerprints → `compareEnv` → rows and counts → stored in `receipts` with a guard (digest of both shapes), shown in UI with the receipt id.

**Project comparison** (`src/main/compare.ts`, `src/shared/pairing.ts`): two `{ root, project }` sides → each root is granted for the session if it is a remembered root of any source (never anything else) → both projects scanned fresh → files paired by _identity_ = the file's path inside its project directory (`envIdentity` strips the longest leading run of segments that is a suffix of the project label, so `apps/api/.env.production`, Vercel `.env.production` and Railway `api/.env.production` meet) → one guarded receipt per pair, files only one side has listed, an identity shared by several files on one side reported as ambiguous and never paired. Opening a pair makes it the ordinary A/B receipt.

### 4.3 Approved sync (done)

Receipt → `planSync` → approval dialog shows source · project · file on both sides, per-key ops and the platform consequence → user confirms once → `applyPlan` (`src/main/write.ts`): the quoted receipt's guard is recomputed from fresh reads of both sides and the apply is refused if either moved → values are selected from the re-read source (blank, absent and names-only keys skipped) → file targets: mtime guard + snapshot + atomic rename; Vault: CAS; provider targets: shape-only snapshot, then the adapter's `apply` (re-read of the target, its own staleness check on the provider timestamp/version, write through the documented API in order with **no retry**, read-back) → `ApplyResult { written, skipped, verified, note }` → event row with key names, counts, plan id and `verified`. No scheduler, no bulk propagation, no auto-retry that writes, no automatic creation or deletion of target environments.

### 4.4 Local file write (done)

Same as 4.3 with the file adapter: write to a temp sibling, rename. Comments and ordering preserved. Never overwrite a file whose mtime changed since the plan.

### 4.5 History and rollback (done)

Every action appends an event. Every compare stores a redacted receipt. File snapshots are sealed with the OS keyring before every file write; provider applies record key names only (the platform's own version history is the rollback path).

## 5. Provider adapters (as built)

Every source is a _ref_ string and every read in main goes through one seam, `src/main/fs.ts`: a local path, `ssh://host/path`, `docker://[host]/container/path`, `vault://conn/mount/path`, or `<provider>://<connectionId>/<target>` for the API providers. Adapters live one folder per provider under `src/main/providers/` and register a backend:

```ts
type ProviderBackend = {
  scan(root, ref): Promise<ScanResult> // targets → environment "files" (metadata only, no values fetched)
  readText(ref): Promise<string> // canonical KEY=value text; values exist only inside this call
  stat(ref): Promise<Stat> // provider timestamp where the API has one
  apply?(ref, { entries, expectedMtime, token }): Promise<{ written; verified; note?; version? }>
  // approved values only, re-read the target first, documented API, no retry, read back
}
// plus, per provider: connect(store, spec) → preflight, connection row, root
```

Rendering to `.env` text (`providers/envtext.ts`) is what lets the existing parser, fingerprinting, receipts, viewer and reveal work unchanged. A key a provider reports by name only (GitHub secrets, Vercel `sensitive`, ECS `secrets`) is rendered with a stand-in value; `envShape` turns it into the `unknown` fingerprint, `compareEnv` classifies it as `unknown` (never `same`/`changed`), and `applyPlan` skips it.

Shared pieces: `providers/http.ts` (plain `node:https`, custom CA via `Agent({ ca })`, typed `ProviderError` per branch, cursor/page helper), `providers/connection.ts` (session-token map, `safeStorage` opt-in sealing, drop-on-remove), `providers/writekit.ts` (apply entries in order with no retry and an error that names what already landed; read-back verdicts). Vault keeps its own client (check-and-set). AWS adapters use `@aws-sdk/client-secrets-manager` (`PutSecretValue` with a unique `ClientRequestToken`, `DescribeSecret` staging labels to detect a concurrent writer) and `@aws-sdk/client-ecs` (`RegisterTaskDefinition` from the described definition minus its read-only fields, `UpdateService` only after a re-check) with `fromNodeProviderChain({ profile })`; ECS Exec mode shells out to `aws ecs execute-command` as an argument array, wraps the container-side output in markers + base64 to survive the pty, and never writes (those files die with the task). GitHub secrets are sealed with `libsodium-wrappers` (`crypto_box_seal`, pinned) against the scope's public key. Docker is a transport variant of SSH inside `fs.ts` (`docker exec <container> sh -c <script>`), not a provider: it reads and writes files.

Per-platform write limits (what the API cannot do, stated in the UI instead of faked): GitHub secret values and Vercel `sensitive` values cannot be read back (presence only); new GitHub organization entries need a visibility Drift cannot choose; Vercel `system` variables and ECS keys sourced from `secrets` are refused by name; Railway, Render and Dokploy carry no per-variable version, so the plan guard is their staleness check. The MCP server never writes itself: its `apply_sync` asks main to run the same `applyPlan` for a plan main created.

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
| MCP for coding agents                                              | Local stdio process; source, compare, plan and apply calls go to the app over a local authenticated socket.      |
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

`mcp.js` is bundled with the app and run under the app binary with `ELECTRON_RUN_AS_NODE=1`, stdio transport via `@modelcontextprotocol/sdk`. Two groups of tools:

- `list_projects`, `env_status`, `compare_env`, `dry_run_plan` read the folder, SSH and Docker roots of the active workspace directly (SQLite opened read-only for the root list, the same granted-root allow-list as main). They work with the app closed.
- `list_sources`, `compare_projects`, `create_sync_plan`, `apply_sync` are answered by the running app over the **bridge** (`src/main/bridge.ts`): a Unix socket in userData (a random named pipe on Windows) plus a 256-bit token, fresh per launch, written to `userData/bridge.json` with mode 0600 and unlinked on quit. The companion reads the file next to the database it was given; the token is never in a client config, a prompt or a tool result. One JSON line per connection, constant-time token check, size and read timeouts, zod-validated params.

Request model on the bridge: a source root exactly as remembered in Drift plus a relative env-file path (or a project name). Main refuses absolute paths and `..`, resolves only against roots in the store, and requires the file to be one the scan found. `create_sync_plan` runs `compareGuarded` (receipt bound to the ordered refs and both redacted shapes), takes the target's mtime or Vault version like the desktop Apply dialog, and keeps the plan in main memory under an opaque id for 15 minutes, single use. `request_sync_approval` takes `plan_id` and the exact ordered keys (add/update/review keys of that plan, each once), shows a native `dialog.showMessageBox` on the app window naming source, target, keys and consequence, and only the "Write" button mints a 256-bit approval token kept in main memory for 5 minutes, bound to that plan, direction and key list; Cancel, Escape and closing the dialog return an error. `apply_sync` takes `plan_id`, the same keys and that token, consumes the token before anything is read (a failed write cannot be replayed), re-checks both roots are still remembered, then calls `applyPlan`, so the file, Vault and provider guards, the snapshot and the audit event are identical to a desktop apply. Responses carry key names, classes, counts, snapshot and version ids. No `get_secret`, no file read, no shell. With the app closed, locked, MCP switched off, or a source removed, those tools fail closed with an "open Drift" error; there is no fallback that reads credentials from disk.

## 8. Threat model in one paragraph

Protects against: leaking values into chat, logs, receipts, screenshots, agent context, crash reports, and against a compromised renderer reading files or credentials. Also against a lost laptop where the OS keychain is locked (secrets are ciphertext, values are not stored). Does not protect against: malware running as the user while the session is unlocked, a malicious `.env` file trying to exploit the parser (parser is a small regex state machine, fuzz it), or a compromised provider token being used elsewhere. Same honest baseline JustEnvs documents.

## 9. Open decisions

1. Fingerprint key: move from per-session to per-install (needs the store). Yes, do it with milestone 1 persistence.
2. Encrypted file snapshots for rollback: opt-in per project. Default off.
3. Share relay: Cloudflare Worker + KV, hosted under theplumbr.com (`share.theplumbr.com` is already the placeholder on the site). Needs a go from the user, since it is the one hosted piece.
4. Linux without a keyring: session-only connections, never plaintext. Confirm this is acceptable UX.
5. Provider order: GitHub and Vercel first (site marks them Popular), then Railway/Render, then Dokploy/Coolify, then AWS/Vault. AWS/Vault are the ones the earlier plan wanted first for validation, so pick based on the first design partners.
