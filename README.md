# Plumbr Env (desktop)

Stop copy-pasting secrets into every platform.

Plumbr Env is a local-first desktop app. It finds every `.env*` in a workspace you grant, shows the drift between environments as redacted receipts, and syncs to GitHub, Vercel, AWS, Vault and the rest. Only when you approve the plan.

Marketing site and copy live in [PiperGuy/theplumbr](https://github.com/PiperGuy/theplumbr) (theplumbr.com). This repo is the app.

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

| Feature                       | Site copy                                                                                                                                                | Status                           |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| Workspace discovery           | Grant a root. Finds every `.env*`, groups by Git project, leaves files in place. Metadata first.                                                         | done (basic)                     |
| Redacted drift receipts       | Every difference between two environments, by key name and class: same, changed, missing, extra, blank, ignored. Values compared as local fingerprints.  | done (two local files)           |
| Dry-run sync plan             | A receipt becomes a plan: add, update, keep, review. Extra keys never removed automatically.                                                             | done (descriptive only)          |
| Per-environment secrets       | Production, staging and preview side by side per project. Switch context without copy-paste.                                                             | todo                             |
| Two-way repo sync             | Link a project to its folder, pull or push its .env in one click, diff before anything lands.                                                            | todo                             |
| Local history and audit trail | Every change and every approved sync recorded on the machine, roll back.                                                                                 | todo                             |
| Share links instead of Slack  | Link that expires by time or view count. Sealed on device before it leaves, revocable. Recipient decrypts in the browser, no account.                    | todo                             |
| Platform sync, human-approved | GitHub Actions, Vercel, Railway, Render, Dokploy, Coolify, AWS Secrets Manager, HashiCorp Vault KV v2. One reviewed plan at a time. Read back for drift. | todo                             |
| Native desktop app            | Menu-bar app for macOS, Windows, Linux. Biometric unlock where the OS supports it. No server to run.                                                     | shell done, tray/biometrics todo |
| MCP for coding agents         | Local MCP server: key names, mismatch classes, dry-run plans. Never values. Cannot execute a sync.                                                       | todo                             |
| Light and dark mode           | Same lemon accent as the site.                                                                                                                           | done                             |

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

- [ ] Provider interface: `read(target) → KeyEntry[]`, `plan(receipt)`, `apply(plan)` with per-key results. Apply is only callable from the approval dialog
- [ ] Credential storage with `safeStorage` (OS keychain backed), never in plain files
- [ ] GitHub Actions: repository, environment and organization secrets (public-key encryption via libsodium/tweetnacl), read-back of key names
- [ ] Vercel: project env vars, production/preview/development targets, branch-scoped previews
- [ ] Railway, Render (environment groups), Dokploy and Coolify (custom endpoint, custom CA)
- [ ] AWS Secrets Manager: JSON secret ⇄ .env mapping, per-region, uses local AWS credentials
- [ ] HashiCorp Vault KV v2: paths, namespaces, self-hosted or HCP
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
