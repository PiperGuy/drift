# Drift by Plumbr (desktop)

Stop copy-pasting secrets into every platform.

Drift is Plumbr's local-first desktop app. It finds every `.env*` in a workspace you grant, shows the drift between environments as redacted receipts, and syncs to GitHub, Vercel, AWS, Vault and the rest. Only when you approve the plan.

Marketing site and copy live in [PiperGuy/theplumbr](https://github.com/PiperGuy/theplumbr) (theplumbr.com). This repo is the app.

Docs: [Features](docs/features.md) (everything the site promises, with status) and [System design](docs/system-design.md) (local-first architecture, storage, what needs a relay).

## Product rules (do not break these)

- **Local-first.** Discovery, parsing and comparison run on the user's machine. There is no Plumbr server in the loop for core features.
- **Files stay where they are.** Never move, copy or rewrite a `.env*` unless the user approves an exact plan.
- **Redacted by default.** Values never leave the main process. Receipts, plans, the UI and MCP see key names, session fingerprints and classes only.
- **Every sync is human-approved.** No scheduler, no unattended write path. MCP cannot execute a sync.
- **Least privilege.** Main only reads paths under a root the user picked in the OS folder dialog. Renderer is sandboxed and talks to main through one typed bridge.

## Stack

| Layer     | Choice                                                                                                                     |
| --------- | -------------------------------------------------------------------------------------------------------------------------- |
| Shell     | Electron 43, [electron-vite](https://electron-vite.org) 5, electron-builder 26                                             |
| UI        | React 19, TypeScript 5.9, Tailwind CSS 4, [shadcn/ui](https://ui.shadcn.com) (radix-ui, lucide-react, sonner, next-themes) |
| State     | zustand                                                                                                                    |
| Contracts | zod at the IPC boundary                                                                                                    |
| Tests     | vitest 4 (+ jsdom, testing-library for renderer tests)                                                                     |
| Quality   | eslint 9 (electron-toolkit config), prettier                                                                               |
| Logging   | electron-log                                                                                                               |
| Updates   | electron-updater (GitHub releases, wired in `electron-builder.yml`, not enabled yet)                                       |

Version pins worth knowing: electron-vite 5 wants Vite 7 (so `@vitejs/plugin-react` 5), and typescript-eslint wants TypeScript < 6.1. Bump those together.

## Layout

```
src/
  main/        Electron main process. Owns the file system, dialogs, IPC handlers.
    index.ts   window + security flags
    ipc.ts     handlers, zod-validated
    workspace.ts granted roots + .env* discovery (metadata only)
    env.ts     read a granted file, parse, fingerprint. Raw values die here.
    fs.ts      one ref-keyed seam for every source: local, ssh://, docker://, vault://, <provider>://
    providers/ vault/ (read + CAS writes), and read-only adapters: vercel, github, railway, render,
               dokploy, coolify, aws/ (Secrets Manager, ECS). http.ts, connection.ts, envtext.ts are shared.
  preload/     contextBridge. Exposes `window.plumbr` (typed, tiny). Sandboxed, so it may only import ./shared/channels.
  shared/      Pure code used on both sides. drift.ts (receipts, plans, MCP context), env-file.ts (parser), channels.ts (IPC contract), ipc.ts (zod schemas).
  renderer/    React app. pages/, store/ (zustand), components/ui (shadcn, generated), components/app (ours).
```

## Scripts

```bash
npm install          # Node 24 (see .node-version). First install downloads Electron.
npm run dev          # electron-vite dev with HMR
npm run check        # typecheck + lint + prettier + tests
npm test             # vitest
npm run ui:add -- dialog   # add a shadcn component
npm run build        # typecheck + bundle to out/
npm run build:mac | build:win | build:linux   # installers via electron-builder
```

`package.json#allowScripts` whitelists install scripts (electron, esbuild, electron-winstaller) for npm 11's script gating. Re-approve after bumping those.

## Features (from theplumbr.com)

The website promises these. Everything below is either done, in progress or on the todo list.

| Feature                       | Site copy                                                                                                                                                | Status                                                                                                                                                                                                                                                                 |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace discovery           | Grant a root. Finds every `.env*`, groups by Git project, leaves files in place. Metadata first.                                                         | done (basic)                                                                                                                                                                                                                                                           |
| Redacted drift receipts       | Every difference between two environments, by key name and class: same, changed, missing, extra, blank, ignored. Values compared as local fingerprints.  | done (two local files)                                                                                                                                                                                                                                                 |
| Dry-run sync plan             | A receipt becomes a plan: add, update, keep, review. Extra keys never removed automatically.                                                             | done (descriptive only)                                                                                                                                                                                                                                                |
| Per-environment secrets       | Production, staging and preview side by side per project. Switch context without copy-paste.                                                             | partial: per-project file matrix and redacted key counts. No reveal                                                                                                                                                                                                    |
| Two-way repo sync             | Link a project to its folder, pull or push its .env in one click, diff before anything lands.                                                            | todo                                                                                                                                                                                                                                                                   |
| Local history and audit trail | Every change and every approved sync recorded on the machine, roll back.                                                                                 | todo                                                                                                                                                                                                                                                                   |
| Share links instead of Slack  | Link that expires by time or view count. Sealed on device before it leaves, revocable. Recipient decrypts in the browser, no account.                    | todo                                                                                                                                                                                                                                                                   |
| Platform sync, human-approved | GitHub Actions, Vercel, Railway, Render, Dokploy, Coolify, AWS Secrets Manager, HashiCorp Vault KV v2. One reviewed plan at a time. Read back for drift. | Vault KV v2 done (source + CAS-guarded target, version history). GitHub Actions, Vercel, Railway, Render, Dokploy, Coolify, AWS Secrets Manager and ECS are read-only sources (connect, scan, redacted receipts, read back for drift). Writes to those platforms: todo |
| Native desktop app            | Menu-bar app for macOS, Windows, Linux. Biometric unlock where the OS supports it. No server to run.                                                     | shell done, tray/biometrics todo                                                                                                                                                                                                                                       |
| MCP for coding agents         | Local MCP server: key names, mismatch classes, dry-run plans. Never values. Cannot execute a sync.                                                       | todo                                                                                                                                                                                                                                                                   |
| Light and dark mode           | Same lemon accent as the site.                                                                                                                           | done                                                                                                                                                                                                                                                                   |

## Todo

Order is a suggestion. Each item should land with a vitest test where there is logic, and must keep the product rules above.

### Milestone 1: Workspace and receipts (usable alone)

- [x] Electron + Vite + React + Tailwind 4 + shadcn/ui scaffold, sandboxed renderer, typed IPC bridge
- [x] Grant a workspace root via OS dialog. Main refuses paths outside granted roots
- [x] Discovery: walk root, skip `node_modules`/`.git`/build dirs, group by nearest `.git`, metadata only
- [x] `.env` parser (quotes, export, comments, multi-line) with tests
- [x] Redacted shape: per-session HMAC fingerprints, blank detection
- [x] Drift receipt between two files + dry-run plan + MCP context shape (ported from the site, with tests)
- [ ] Persist granted roots and settings (electron `safeStorage` + a JSON file in `app.getPath('userData')`, no new dependency)
- [ ] Watch granted roots with `fs.watch` (recursive) and refresh the table live
- [ ] Per-project view: environments side by side (`.env`, `.env.local`, `.env.staging`, `.env.production`, `.env.preview`)
- [ ] Ignore list per project (defaults to `NODE_ENV`), editable in Settings
- [ ] Reveal-in-Finder/Explorer and open-in-editor actions (`shell.showItemInFolder`)
- [ ] Custom app icon and tray/menu-bar mode (`Tray`, quick receipt from the tray)
- [ ] Renderer tests for Workspace and Receipt pages (testing-library + jsdom)

### Milestone 2: Local history and repo sync

- [ ] Local history: snapshot the redacted shape (and, opt-in, an encrypted copy of the file) on every change. SQLite via `node:sqlite` when it stabilises, JSON log until then
- [ ] Audit trail entries for every approved action
- [ ] Roll back a file to a previous snapshot (writes only after explicit confirmation)
- [ ] Two-way repo sync: link project ↔ folder, pull/push with a diff shown first

### Milestone 3: Human-approved platform sync

- [x] Provider read seam: every source is a ref (`<provider>://<connection>/<target>`) behind `src/main/fs.ts`; adapters register `readText`, `stat`, `scan`. `apply` exists for local files, SSH, Docker and Vault only
- [x] Credential storage with `safeStorage` (OS keychain backed), never in plain files; session-only by default, keyring on opt-in; AWS via the SDK credential chain (profile name + region stored, never a key)
- [x] GitHub Actions read: repository, environment and organization variables (values) and secrets (names only, GitHub never returns them: compared as `unknown`, never `changed`)
- [ ] GitHub Actions write: public-key encryption via libsodium/tweetnacl
- [x] Vercel read: project env vars, production/preview/development targets, branch-scoped previews (`branches/<branch>/.env.preview`); sensitive vars are names only
- [x] Railway (shared + per-service variables per environment), Render (environment groups + service variables), Dokploy and Coolify (custom endpoint, custom CA) read
- [x] AWS Secrets Manager read: JSON object secret → .env, per region and profile, one secret or a `prefix/`; binary and non-object secrets refused
- [x] AWS ECS read: cluster → service (or task) → container picked from SDK lists; task-definition environment through the API (no command runs), or files in the running container with ECS Exec on explicit opt-in
- [x] Docker: files in a running container (local daemon or `-H ssh://host`), same read/compare/write path as SSH
- [x] HashiCorp Vault KV v2: paths, namespaces, self-hosted or HCP; token or AppRole auth, keyring opt-in, check-and-set writes, version history with compare and restore (`src/main/providers/vault/`)
- [ ] Platform writes (Vercel, GitHub, Railway, Render, Dokploy, Coolify, AWS Secrets Manager) behind the same exact-plan + re-read-before-apply flow as Vault
- [ ] Approval dialog: exact source → target plan, per-key ops, extra keys shown as "keep", one plan at a time
- [ ] Integrations page in-app matching the site's support matrix

### Milestone 4: Share links instead of Slack

- [ ] Client-side sealing (WebCrypto AES-GCM, key in the URL fragment so the server never sees it)
- [ ] Share service (small, separate repo): store ciphertext, expiry by time and open count, revoke endpoint, no accounts
- [ ] Recipient page that decrypts in the browser
- [ ] In-app: create link, copy, see opens, revoke, and a history entry per share

### Milestone 5: Agents and polish

- [ ] Local MCP server (`@modelcontextprotocol/sdk`, stdio): tools for receipts, mismatch context and dry-run plans, read-only, no values
- [ ] One-click MCP config for Claude Code and Cursor
- [ ] Biometric unlock (Touch ID via `systemPreferences.promptTouchID`, Windows Hello via `safeStorage` prompt) for revealing values or approving syncs
- [ ] Auto-update via electron-updater and GitHub releases, code signing and notarization
- [ ] Onboarding that explains what is and is not read, in the same words as the site
- [ ] Crash and error reporting that never includes values (electron-log scrubbing)

## Security notes for contributors

- Renderer: `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, strict CSP in `src/renderer/index.html`, external links open in the system browser, in-app navigation blocked.
- Preload exposes only `window.plumbr` (see `src/shared/channels.ts`). Add a channel there, validate it in `src/main/ipc.ts` with zod, then use it.
- Never send a raw value over IPC, log one, or put one in an error message. Fingerprints are HMAC-SHA256 with a per-session random key.
- Never commit secrets. `.env*` is ignored.

## Releasing

```bash
npm run release:patch   # or release:minor / release:major
```

`npm version` bumps `package.json`, commits `release: vX.Y.Z` and pushes the tag. The
tag triggers `.github/workflows/release.yml`, which runs `npm run check` and builds on
macOS, Windows and Linux, then attaches the installers (`.dmg`, `-setup.exe`, `.AppImage`,
`.deb`) to a **draft** GitHub Release. Review the draft and publish it. Builds are
unsigned until these repository secrets exist, after which the same workflow signs and
notarizes with no other change: `CSC_LINK` + `CSC_KEY_PASSWORD` (Developer ID Application .p12,
base64), `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID` (notarization),
`WIN_CSC_LINK` + `WIN_CSC_KEY_PASSWORD` (Windows code-signing .pfx). Unsigned: macOS users open
via right-click → Open the first time, Windows shows SmartScreen. `Actions → Release → Run workflow` builds the current branch without
publishing; installers are attached to the run as artifacts.

## Sources and the sidebar

The sidebar (drag its edge to resize, ⌘/Ctrl+B to collapse) holds the **Workspace | Compare**
switch, the **source** switcher and the project list with search (⌘/Ctrl+F). A source is a named
folder or server; **Add source…**, **Update source…** (rename, or point it elsewhere) and
**Remove source** live in the switcher menu, and the header has an Update source button. Switching
sources swaps what is scanned and compared; nothing on disk changes. In the file table, click a row
to open it and right-click for Compare as A / B, Sync and Share. Settings (gear, bottom-left) holds
theme, licence, agents, the audit log with snapshots, and data.

## Roots: several folders, and servers over SSH

Workspace → **Add source** opens the source picker. Every entry is live: Local folder, SSH server, EC2 instance (SSH), Docker container, ECS container, AWS Secrets Manager, HashiCorp Vault KV v2, GitHub Actions, Vercel, Railway, Render, Dokploy and Coolify. Folders, SSH, EC2 and Docker are file sources (read, compare, edit, format, apply). Vault is read + check-and-set write. The rest are read-only (see the next section).
A Vault source points at one KV v2 secret (one environment) or a folder of them (each leaf becomes an environment). Connect runs a preflight (health, token, mount version, capabilities); reads render redacted shapes; every write is a reviewed, check-and-set-guarded new version, and the file header's History button compares and restores versions. Tokens stay in memory for the session unless you opt into the OS keyring. The MCP server deliberately cannot read Vault sources (credentials never leave the app).
Every root is listed in the sidebar with its projects; the × on a root stops reading it (files
untouched). SSH uses the `ssh` binary on your machine, so `~/.ssh/config` aliases, keys, the
agent, ProxyJump and known_hosts all apply and Drift stores no credentials. Key/agent auth only
(BatchMode). The server needs GNU coreutils (any Linux VPS). Reads, compares, reveals, edits,
formats and rollbacks work the same on remote files: values still stay in main, writes are still
temp-file + rename with the same mtime guard. **EC2 instance** is the same SSH source with a
user + public DNS form: Drift uses the SSH key pair you chose at launch (loaded in your agent),
never AWS credentials. **Docker container** runs `docker exec <container> sh -c …` through the
`docker` CLI on this machine (a remote daemon via `-H ssh://user@host`, so the same ssh config
applies); the container must be running and have `sh` + coreutils. Reads and writes work exactly
like SSH. Container names and paths are validated and passed as argument arrays, never a shell
string.

## Read-only provider sources

ECS, AWS Secrets Manager, GitHub Actions, Vercel, Railway, Render, Dokploy and Coolify connect
from the main process with your own credentials, straight to the provider (no Plumbr service, no
proxy, no polling). Connect runs a preflight, then each source scans into environment "files"
whose contents are rendered `KEY=value` text, so receipts, the viewer, reveal and MCP-free
compare all work unchanged. They are **read-only**: Apply to B is disabled when B is one of them,
the viewer hides Format / Edit / Add key, and main refuses any write. Change values in the
provider, then rescan. Tokens live in memory for the session; tick the keyring box to seal one
with `safeStorage`. Config rows never hold a credential. Removing the source (or the workspace, or
Forget data) deletes the connection and drops the token.

Some providers return names but not values. Those keys render with a stand-in value, show as
"reported by name only" in the viewer, and compare as **unknown** (present on both sides, value
unknowable), never as `same` or `changed`. Apply never copies a stand-in.

| Source              | What becomes a file                                                                                                                             | Values               | Limits                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AWS Secrets Manager | one JSON-object secret, or every JSON-object secret under a `prefix/`                                                                           | yes                  | Binary, plaintext and non-object JSON secrets fail with a safe message. Nested values are counted, not shown. SDK credential chain (profile, SSO, env); only region + profile name stored.                                                                                                                                                                                                                                        |
| ECS container       | cluster → `service:<name>` (follows deployments) or `task:<id>` → container. Default: the task definition's `environment` + `secrets` as `.env` | `environment` yes    | `secrets` are names only (resolved inside the task). `environmentFiles` (S3) are noted, not read. Optional **ECS Exec** mode reads `.env*` files under a directory in the running container via `aws ecs execute-command`: needs AWS CLI v2, the Session Manager plugin, `enableExecuteCommand` and `ecs:ExecuteCommand`; every scan/read runs `find`/`stat`/`cat` in the container, so it is opt-in per source and never writes. |
| GitHub Actions      | `.env` (repository or organization) + `.env.<environment>`                                                                                      | variables yes        | Secrets are names only: drift is present / missing, never changed. Fine-grained PAT with Actions secrets + variables read (and Environments read).                                                                                                                                                                                                                                                                                |
| Vercel              | `.env.production`, `.env.preview`, `.env.development`, `branches/<branch>/.env.preview`                                                         | yes (`decrypt=true`) | `sensitive` vars are names only. Team projects need the team id.                                                                                                                                                                                                                                                                                                                                                                  |
| Railway             | `.env.<environment>` (shared) and `<service>/.env.<environment>`                                                                                | yes                  | Account or team token; project tokens are not supported.                                                                                                                                                                                                                                                                                                                                                                          |
| Render              | `env-groups/<name>/.env`, `services/<name>/.env`                                                                                                | yes                  | Secret files in a group are listed in a comment, not read.                                                                                                                                                                                                                                                                                                                                                                        |
| Dokploy             | `<project>/[<environment>/]<application>/.env` (the stored env text as-is)                                                                      | yes                  | Custom CA supported. Compose services not listed.                                                                                                                                                                                                                                                                                                                                                                                 |
| Coolify             | `<application>/.env` and `.env.preview`                                                                                                         | yes                  | Custom CA supported. A variable the API returns without a value is names only.                                                                                                                                                                                                                                                                                                                                                    |

Every provider error names its branch (invalid config, no credentials, expired SSO session,
unauthorized, forbidden scope, not found, malformed response, rate limit with retry-after, timeout,
unreachable host) and never contains a token, URL query or value.

## Viewing a file

Workspace → click a file name. **UI** shows a card per key: a kind guessed from the name
(secret / url / number / flag / config), line, length, quoting, `export`, whether a later
assignment shadows it, and any lint findings. **File** shows the source with line numbers,
colouring and a lint gutter. Values are masks of the same length; the eye reveals one key
behind OS auth for 20 s. **Format** rewrites spelling only (`KEY=value`, quotes where needed,
whitespace, LF, final newline) via the snapshot + atomic path; meaning, order and comments are
untouched. Lint rules: duplicate-key, invalid-line, unquoted-space, unquoted-hash,
surrounding-space, key-case, trailing-whitespace, empty-value, no-final-newline, crlf,
mixed-export, secret-in-example.

## Editing a file

In the viewer's UI mode, the pencil on a key opens an inline value field (prefilled only if you
revealed that key; otherwise the current value stays hidden and you type a replacement). **+ Add
key** appends a new one. Edits collect into an unsaved-changes bar; **Save** writes them through
the same mtime-guarded snapshot + atomic path, keeping `export` prefixes and trailing comments.
Closing the viewer or switching project with unsaved edits asks first. Keys are never deleted here.

## Writing files

The only write path is Receipt → Dry-run plan → **Apply to B…**. The dialog lists the exact keys
(add and update pre-checked, review opt-in, keep never offered). Main then refuses if B changed
since the plan, snapshots B into `file_history` (bytes sealed by the OS keyring), and writes a
temp file renamed over B. Each key's assignment is copied verbatim from A, so quoting, `export`
and trailing comments survive; B's comments, order and extra keys are untouched. History →
Snapshots restores any earlier state (snapshotting the current one first).

## Native behaviour

- **Reveal a value:** Workspace → click a file → eye on a key. Main asks the OS first: Touch ID on
  macOS, a polkit prompt on Linux, a native confirm dialog on Windows (Electron has no Windows
  Hello API). The value is shown for 20 s and the reveal is logged by key name only.
- **Updates:** a packaged build checks GitHub Releases 10 s after launch, downloads in the
  background and offers "Restart to update". Settings → Updates checks on demand.

## MCP for coding agents

The app bundles a stdio MCP server (`out/main/mcp.js`) that runs under the app binary with
`ELECTRON_RUN_AS_NODE=1`, so nothing else needs installing. Open **Agents** in the app and copy
the one-liner for Claude Code or the JSON for Cursor and friends. Tools: `list_projects`,
`env_status`, `compare_env`, `dry_run_plan`. It reads only the workspace granted in the app,
returns key names and drift classes, never values, and has no write or sync tool. It can read
folder, SSH and Docker sources; Vault and provider sources need credentials that stay in the app,
so it refuses those with a clear message.

## Licensing and trial

Every install gets a 7-day trial, tracked in the local store. After that the window locks and
main refuses every data IPC (the MCP server refuses tool calls too) until a key is entered in
Settings → License. Keys are offline, Ed25519-signed, verified against the public key in
`src/shared/license-pubkey.ts`. Nothing is sent anywhere.

```bash
node scripts/license.mjs keygen                         # once: writes the public key file, prints the private key
export DRIFT_LICENSE_PRIVATE_KEY=…                      # keep this in a password manager, never in the repo
node scripts/license.mjs issue customer@example.com 365 # a key valid for 365 days; omit days for perpetual
```

**Before the first public release, run `keygen` on your own machine and commit the new
public key.** The pair in the repo today was generated during development. A local trial is
bypassable by anyone willing to delete app data; a licence server is the upgrade path if that
matters.
