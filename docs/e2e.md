# Desktop end-to-end tests

Real E2E: Playwright's `_electron` driver launches the **built** Electron app
(`out/main/index.js`, the same bundles a packaged build ships), and every test
drives the real renderer → preload → main path. Nothing is mocked; the unit
suite (`npm test`) stays separate.

## Running

```bash
npm run test:e2e          # builds (electron-vite + MCP bundle), then runs Playwright
```

Prerequisites: `npm install` (downloads the Electron binary) and a display. On
headless Linux (CI, servers) wrap in a virtual X server:

```bash
xvfb-run -a npm run test:e2e
```

The harness launches Electron with `--no-sandbox --disable-gpu` because CI
runners lack the SUID/user-namespace Chromium sandbox. The app's own renderer
protections (`sandbox: true`, `contextIsolation: true`, `nodeIntegration:
false`) are unaffected — and asserted by `e2e/boot.spec.ts`.

## What is covered

| Spec             | Proves                                                                                                                                              |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `boot.spec.ts`   | Fresh boot shows onboarding; renderer exposes only the typed `window.plumbr` bridge (no `require`/`process`/raw ipc); ungranted paths are refused.  |
| `drift.spec.ts`  | A fixture project with several `.env*` files is scanned, a pair is compared, every drift class shows in the real UI, and no raw value is rendered.  |
| `sync.spec.ts`   | The approved sync path: plan tab → approval dialog → write. Only ticked keys change, extras are retained, the write receipt names keys, not values. |
| `guards.spec.ts` | A stale plan (target edited after compare) is refused and a cancelled approval writes nothing — the target file is byte-identical afterwards.       |

## Determinism and isolation

- Every test gets a **fresh temp userData dir** and a **fresh fixture
  workspace** (created in `e2e/fixtures.ts`, deleted afterwards). No test
  touches your real Drift data or any real project.
- All fixture values are obviously fake (`fixture-…-not-a-real-secret`). No
  network, provider or credential is involved, and no ports are opened.
- Screenshots are captured **only on failure**. The UI never renders raw
  values, so failure output cannot leak them; assertions that compare file
  contents are written as booleans so values don't land in CI logs either.

## The E2E-only bootstrap

The OS folder picker cannot be driven headlessly, so `src/main/e2e.ts` provides
a deliberately narrow stand-in, active **only** when the app is _not packaged_
**and** the runner sets `DRIFT_E2E=1` — a shipped build can never enter it:

- `DRIFT_E2E_USERDATA` — points `userData` at a throwaway directory.
- `DRIFT_E2E_GRANT_ROOT` — remembers exactly one fixture workspace root at
  startup, the same thing a user grants through the picker.

Both are fixed at process start; there is no runtime IPC, no extra filesystem
access and no way to read or reveal values through it. Every production guard
(granted-root checks, plan freshness, mtime guards, approval dialogs,
redaction) stays fully active in E2E runs — that is the point of the suite.

## CI

`.github/workflows/ci.yml` runs on every PR and push to main: `npm ci`, the
regression gate (`typecheck`, `lint`, `format:check`, `test`), a production
build, then this suite under `xvfb-run`. On failure the `e2e-results/` output
(screenshots, error context) is uploaded as the `e2e-failure-output` artifact
for 7 days. Workflow intent is guarded by `tests/workflows.test.ts`.
