# Drift by Plumbr (desktop)

Stop copy-pasting secrets into every platform.

Drift is Plumbr's local-first desktop app. It finds every `.env*` in a workspace you grant, shows the drift between environments as redacted receipts, and syncs to GitHub, Vercel, AWS, Vault and the rest. Only when you approve the plan.

Marketing site and copy live in [PiperGuy/theplumbr](https://github.com/PiperGuy/theplumbr) (theplumbr.com). This repo is the app.

Docs: [Features](docs/features.md) (everything the site promises, with status) and [System design](docs/system-design.md) (local-first architecture, storage, what needs a relay).

## Product rules (do not break these)

- **Local-first.** Discovery, parsing and comparison run on the user's machine. There is no Plumbr server in the loop for core features.
- **Files stay where they are.** Never move, copy or rewrite a `.env*` unless the user approves an exact plan.
- **Redacted by default.** Values never leave the main process. Receipts, plans and the UI see key names, session fingerprints and classes; MCP sees key names, classes and counts only.
- **Every sync is human-approved.** No scheduler, no unattended write path. An agent syncs only through a reviewed plan, a native confirmation dialog the user clicks in the app, and a separate apply call the app itself executes.
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
npm run test:e2e     # desktop E2E: builds, then Playwright drives the real app (docs/e2e.md)
npm run ui:add -- dialog   # add a shadcn component
npm run build        # typecheck + bundle to out/
npm run build:mac | build:win | build:linux   # installers via electron-builder
```

`build:win` is a local-only convenience; no automated workflow builds or publishes
Windows — it is intentionally unavailable (see “CI, main-branch artifacts and releasing”).

On a headless Linux box, run the E2E suite under a virtual display:
`xvfb-run -a npm run test:e2e`. Details and prerequisites: [docs/e2e.md](docs/e2e.md).

`package.json#allowScripts` whitelists install scripts (electron, esbuild, electron-winstaller) for npm 11's script gating. Re-approve after bumping those.

## Features (from theplumbr.com)

The website promises these. Everything below is either done, in progress or on the todo list.

| Feature                       | Site copy                                                                                                                                                | Status                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace discovery           | Grant a root. Finds every `.env*`, groups by Git project, leaves files in place. Metadata first.                                                         | done (basic)                                                                                                                                                                                                                                                                                                                                                                                       |
| Redacted drift receipts       | Every difference between two environments, by key name and class: same, changed, missing, extra, blank, ignored. Values compared as local fingerprints.  | done (two local files)                                                                                                                                                                                                                                                                                                                                                                             |
| Dry-run sync plan             | A receipt becomes a plan: add, update, keep, review. Extra keys never removed automatically.                                                             | done (descriptive only)                                                                                                                                                                                                                                                                                                                                                                            |
| Per-environment secrets       | Production, staging and preview side by side per project. Switch context without copy-paste.                                                             | partial: per-project file matrix and redacted key counts. No reveal                                                                                                                                                                                                                                                                                                                                |
| Two-way repo sync             | Link a project to its folder, pull or push its .env in one click, diff before anything lands.                                                            | todo                                                                                                                                                                                                                                                                                                                                                                                               |
| Local history and audit trail | Every change and every approved sync recorded on the machine, roll back.                                                                                 | todo                                                                                                                                                                                                                                                                                                                                                                                               |
| Share links instead of Slack  | Link that expires by time or view count. Sealed on device before it leaves, revocable. Recipient decrypts in the browser, no account.                    | todo                                                                                                                                                                                                                                                                                                                                                                                               |
| Platform sync, human-approved | GitHub Actions, Vercel, Railway, Render, Dokploy, Coolify, AWS Secrets Manager, HashiCorp Vault KV v2. One reviewed plan at a time. Read back for drift. | done: every platform is a source AND a target (Vault CAS-guarded; GitHub, Vercel, Railway, Render, Dokploy, Coolify, AWS Secrets Manager and ECS services through each platform's own API) behind one plan → confirm → re-read → write → read-back flow. Cross-source project comparison pairs environment files by path. See "Writing to platforms" for what each platform can and cannot confirm |
| Native desktop app            | Menu-bar app for macOS, Windows, Linux. Biometric unlock where the OS supports it. No server to run.                                                     | shell done, tray/biometrics todo                                                                                                                                                                                                                                                                                                                                                                   |
| MCP for coding agents         | Local MCP server: sources, cross-source project compare, sync plans and an explicit apply, all as key names, classes and counts. Never values.           | done: bundled stdio server; read tools work alone, source/plan/apply tools are answered by the running app over a local authenticated bridge                                                                                                                                                                                                                                                       |
| Light and dark mode           | Same lemon accent as the site.                                                                                                                           | done                                                                                                                                                                                                                                                                                                                                                                                               |

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
- [x] GitHub Actions write: libsodium sealed boxes with the scope public key (`libsodium-wrappers`, pinned)
- [x] Vercel read: project env vars, production/preview/development targets, branch-scoped previews (`branches/<branch>/.env.preview`); sensitive vars are names only
- [x] Railway (shared + per-service variables per environment), Render (environment groups + service variables), Dokploy and Coolify (custom endpoint, custom CA) read
- [x] AWS Secrets Manager read: JSON object secret → .env, per region and profile, one secret or a `prefix/`; binary and non-object secrets refused
- [x] AWS ECS read: cluster → service (or task) → container picked from SDK lists; task-definition environment through the API (no command runs), or files in the running container with ECS Exec on explicit opt-in
- [x] Docker: files in a running container (local daemon or `-H ssh://host`), same read/compare/write path as SSH
- [x] HashiCorp Vault KV v2: paths, namespaces, self-hosted or HCP; token or AppRole auth, keyring opt-in, check-and-set writes, version history with compare and restore (`src/main/providers/vault/`)
- [x] Platform writes (Vercel, GitHub, Railway, Render, Dokploy, Coolify, AWS Secrets Manager, ECS services) behind the same exact-plan + re-read-before-apply flow as Vault, each verified by read-back where the platform allows it
- [x] Approval dialog: exact source → target plan with source labels, per-key ops, the platform consequence, one plan at a time
- [x] Cross-source project comparison: source A / project A against source B / project B, files paired by their path inside the project
- [ ] Integrations page in-app matching the site's support matrix

### Milestone 4: Share links instead of Slack

- [ ] Client-side sealing (WebCrypto AES-GCM, key in the URL fragment so the server never sees it)
- [ ] Share service (small, separate repo): store ciphertext, expiry by time and open count, revoke endpoint, no accounts
- [ ] Recipient page that decrypts in the browser
- [ ] In-app: create link, copy, see opens, revoke, and a history entry per share

### Milestone 5: Agents and polish

- [x] Local MCP server (`@modelcontextprotocol/sdk`, stdio): receipts, cross-source compare, plans and an explicit apply, no values
- [x] One-click MCP config for Claude Code and Cursor
- [ ] Biometric unlock (Touch ID via `systemPreferences.promptTouchID`, Windows Hello via `safeStorage` prompt) for revealing values or approving syncs
- [ ] Auto-update via electron-updater and GitHub releases, code signing and notarization
- [ ] Onboarding that explains what is and is not read, in the same words as the site
- [ ] Crash and error reporting that never includes values (electron-log scrubbing)

## Security notes for contributors

- Renderer: `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, strict CSP in `src/renderer/index.html`, external links open in the system browser, in-app navigation blocked.
- Preload exposes only `window.plumbr` (see `src/shared/channels.ts`). Add a channel there, validate it in `src/main/ipc.ts` with zod, then use it.
- Never send a raw value over IPC, log one, or put one in an error message. Fingerprints are HMAC-SHA256 with a per-session random key.
- Never commit secrets. `.env*` is ignored.

## CI, main-branch artifacts and releasing

**Every PR and push to main** runs `.github/workflows/ci.yml`: the full quality gate
(`npm ci`, typecheck, lint, prettier, unit tests, build) plus the desktop E2E suite
against the built Electron app under a headless X server (`xvfb-run`).

**Every merge to main** additionally runs `.github/workflows/main-artifacts.yml`: it
re-runs `npm run check`, then packages installers for the two supported platforms and
uploads them as GitHub **Actions artifacts** on that run (retained 30 days, not
published anywhere else):

- `drift-macos-installers` — `.dmg` and `.zip`
- `drift-linux-installers` — `.AppImage` and `.deb`

These main-branch builds are always **unsigned**. **Windows is intentionally not
built or published** by any automated workflow.

```bash
npm run release:patch   # or release:minor / release:major
```

`npm version` bumps `package.json`, commits `release: vX.Y.Z` and pushes the tag. The
tag triggers `.github/workflows/release.yml`, which runs `npm run check` and builds on
macOS and Linux only, then attaches the installers (`.dmg`, `.zip`, `.AppImage`,
`.deb`) to a **draft** GitHub Release. Review the draft and publish it. Builds are
unsigned until these repository secrets exist, after which the same workflow signs and
notarizes with no other change: `CSC_LINK` + `CSC_KEY_PASSWORD` (Developer ID Application .p12,
base64), `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID` (notarization).
Unsigned: macOS users open via right-click → Open the first time.
`Actions → Release → Run workflow` builds the current branch without
publishing; installers are attached to the run as artifacts.
The intent of all three workflows is guarded by `tests/workflows.test.ts`.

## Sources and the sidebar

The sidebar (drag its edge to resize, ⌘/Ctrl+B to collapse) holds the **Workspace | Compare**
switch, the **source** switcher and the project list with search (⌘/Ctrl+F). A source is a named
folder or server; **Add source…**, **Update source…** (rename, or point it elsewhere) and
**Remove source** live in the switcher menu, and the header has an Update source button. Switching
sources swaps what is scanned and compared; nothing on disk changes. In the file table, click a row
to open it and right-click for Compare as A / B, Sync to another source, and Share (roadmap). Settings (gear, bottom-left) holds
theme, licence, agents, the audit log with snapshots, and data.

## Roots: several folders, and servers over SSH

Workspace → **Add source** opens the source picker. Every entry is live: Local folder, SSH server, EC2 instance (SSH), Docker container, ECS container, AWS Secrets Manager, HashiCorp Vault KV v2, GitHub Actions, Vercel, Railway, Render, Dokploy and Coolify. Folders, SSH, EC2 and Docker are file sources (read, compare, edit, format, apply). Vault is read + check-and-set write. The rest are read-only (see the next section).
A Vault source points at one KV v2 secret (one environment) or a folder of them (each leaf becomes an environment). Connect runs a preflight (health, token, mount version, capabilities); reads render redacted shapes; every write is a reviewed, check-and-set-guarded new version, and the file header's History button compares and restores versions. Tokens stay in memory for the session unless you opt into the OS keyring. The MCP server never holds Vault credentials: an agent reaches a Vault source only through the running app's bridge, which reads and writes on its behalf.
**Compare across sources.** Compare (⌘/Ctrl+2) with no pair ticked shows the project picker: a source and a
project/directory on each side, from any two sources. Drift scans both fresh, pairs environment files by
their path inside the project (`apps/api/.env.production` ↔ Vercel `.env.production` ↔ Railway
`api/.env.production`), compares each pair and lists the files only one side has. Nothing is created for
those. A file path shared by several files on one side is listed as not paired, never guessed. Open a pair
and it becomes the usual A → B receipt with its plan; every header names source · project · file on both
sides so `.env.production` from two sources cannot be confused. A file row's right-click menu has **Sync to
another source…**, which starts the picker with that file as A.
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

## Provider sources

ECS, AWS Secrets Manager, GitHub Actions, Vercel, Railway, Render, Dokploy and Coolify connect
from the main process with your own credentials, straight to the provider (no Plumbr service, no
proxy, no polling). Connect runs a preflight, then each source scans into environment "files"
whose contents are rendered `KEY=value` text, so receipts, the viewer, reveal and cross-source
compare all work unchanged. They are not edited as files (the viewer hides Format / Edit / Add key);
the one write path is Receipt → plan → **Apply to B…**, described under "Writing to platforms".
Tokens live in memory for the session; tick the keyring box to seal one
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

## Writing to platforms

The same dialog writes to a platform when B is a provider environment. Every apply quotes the
receipt it was planned from: main re-reads A and B, refuses if either side's redacted shape moved
since that receipt, drops blank and names-only values, records a shape-only snapshot (key names,
no bytes: the platform's own history is the rollback path), and hands the approved keys to the
adapter, which re-reads the target again, writes through the platform's documented API with no
retry, then reads back. The result says what the read-back confirmed. The dialog names the
platform consequence before you confirm. Nothing is deleted anywhere, and no target file or
environment is created for a file that only exists on one side.

| Target              | How it is written                                                                                                                                                                                                                                                                                          | Read-back                                                 | Limits                                                                                                                                                                                                                                                                           |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vercel              | `PATCH …/env/{id}` for a variable that belongs to this target only; a variable shared across targets is first detached from this target, then a copy is created for it, so preview/development never change. New keys: `POST …/env` with this target (and `gitBranch` for branch files), type `encrypted`. | values, except `sensitive` (present only)                 | `system` variables (VERCEL_URL…) are refused by name. Refuses if the newest `updatedAt` moved since the scan. New values apply to future deployments.                                                                                                                            |
| GitHub Actions      | A key that exists as a secret is re-sealed (libsodium sealed box, scope public key) and `PUT`; a key that exists as a variable is `PATCH`ed; a key new to the scope becomes a **secret**. Organization entries keep their visibility (and selected repositories).                                          | variables by value; secrets by presence only              | New organization secrets/variables are refused: Drift cannot pick which repositories may see them. Create in GitHub, then apply to set the value. Fine-grained PAT needs secrets + variables **write** (environments write for `.env.<env>`).                                    |
| Railway             | One `variableCollectionUpsert` (replace: false) for the ticked keys, scoped to project + environment (+ service; shared variables without a service).                                                                                                                                                      | values                                                    | Railway redeploys the service (its default). No per-variable timestamp: the plan guard is the staleness check.                                                                                                                                                                   |
| Render              | `PUT /services/{id}/env-vars/{key}` or `PUT /env-groups/{id}/env-vars/{key}` per key, in order, stopping at the first failure (the error names what already landed).                                                                                                                                       | values                                                    | Render redeploys affected services unless auto-deploy is off. Secret files are not written.                                                                                                                                                                                      |
| Dokploy             | `application.one` is re-read, the env text patched in place (comments and order kept), `application.saveEnvironment` saves it with build args / secrets / createEnvFile carried through.                                                                                                                   | values                                                    | Redeploy the application to use it. No version to compare-and-set on.                                                                                                                                                                                                            |
| Coolify             | `PATCH /applications/{uuid}/envs` for an existing key (flags kept), `POST` for a new one, `is_preview` set from the file (`.env` vs `.env.preview`).                                                                                                                                                       | values, except shown-once                                 | Redeploy the application to use it. Refuses if the newest `updated_at` moved since the scan.                                                                                                                                                                                     |
| AWS Secrets Manager | `PutSecretValue` with a unique `ClientRequestToken`: the current JSON object with only the ticked keys replaced (other keys keep value and type). `DescribeSecret` afterwards must show the version read before the write as `AWSPREVIOUS`, otherwise a concurrent write is reported.                      | values from the new version                               | JSON object secrets only. SDK credential chain (profile / SSO); no key is ever stored. Refuses if `LastChangedDate` moved since the scan.                                                                                                                                        |
| ECS (service)       | The service's task definition is described, a new revision registered with only this container's `environment` changed (every other field and the tags carried over), the service re-checked, then `UpdateService` starts a rolling deployment.                                                            | values from the new revision + the service pointing at it | Keys that come from `secrets` (Secrets Manager / SSM) are refused: change the secret itself. `task:` sources and ECS Exec directories are ephemeral and refused with the reason. Refuses if the service moved to another revision since the scan or between register and update. |

Values still never reach the renderer, the database, history or logs: the audit entry records
key names, counts, the plan id and whether the read-back verified.

## Native behaviour

- **Reveal a value:** Workspace → click a file → eye on a key. Main asks the OS first: Touch ID on
  macOS, a polkit prompt on Linux, a native confirm dialog on Windows (Electron has no Windows
  Hello API). The value is shown for 20 s and the reveal is logged by key name only.
- **Updates:** a packaged build checks GitHub Releases 10 s after launch, downloads in the
  background and offers "Restart to update". Settings → Updates checks on demand.

## MCP for coding agents

The app bundles a stdio MCP server (`out/main/mcp.js`) that runs under the app binary with
`ELECTRON_RUN_AS_NODE=1`, so nothing else needs installing. Open **Agents** in the app and copy
the one-liner for Claude Code or the JSON for Cursor and friends.

Two groups of tools, one rule: the agent sees key names, drift classes, counts and opaque ids.
Never a value, a fingerprint, a token or raw file text.

- **Read tools that work on their own:** `list_projects`, `env_status`, `compare_env`,
  `dry_run_plan`. They read the folder, SSH and Docker roots of the active workspace directly.
- **Tools the running app answers:** `list_sources` (every source in every workspace, platforms
  and Vault included), `compare_projects` (two projects from any two sources, paired by env-file
  path, like the desktop project picker), `create_sync_plan` (one ordered file pair, returns an
  opaque `plan_id` with key names and actions), `request_sync_approval` (the app shows a native
  dialog naming source, target and the exact keys; only the user's click mints a one-use approval
  token) and `apply_sync` (writes those keys with that token). These go over a local bridge: a Unix socket (named pipe on Windows) plus a fresh
  per-launch token, both in the app's data folder with owner-only permissions, never in the client
  config and never returned by a tool. The app resolves roots only against sources it remembers,
  refuses absolute paths and `..`, re-reads both sides against the plan before writing, and applies
  through the same `applyPlan` path as the desktop, so every file, Vault and platform safeguard
  holds. Plans are single use and expire after 15 minutes; the approval token is random, lives
  only in the app's memory for 5 minutes, is bound to the plan, its direction and the ordered key
  list, and is consumed before anything is read, so an agent (prompt-injected or not) can ask for
  a dialog but cannot write without the human click. If the app is closed, locked or a source was
  removed, those tools fail closed with a message that says to open the app.

## Licensing and trial

Every install gets a 7-day trial, tracked in the local store. After that the window locks and
main refuses every data IPC (the MCP server and its bridge refuse tool calls too) until a key is entered in
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
