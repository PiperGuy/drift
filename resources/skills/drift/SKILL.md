---
name: drift
description: Check environment variable drift between .env files (local, staging, production, preview) for the current project using the Drift MCP server. Use when the user asks whether envs are in sync, what keys are missing before a deploy, what a .env needs, or to review a dry-run sync plan. Never asks for or reveals secret values.
---

# Drift — env drift for coding agents

Drift (by Plumbr) exposes the user's `.env*` files as **key names and drift classes only**.
You will never see a value, and there is no tool that writes or syncs. Treat every answer as
a redacted receipt and keep it that way: do not ask the user to paste values into the chat.

## Tools

| Tool                                 | Use it for                                                                                                                         |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `list_projects`                      | Find the project and its env files. Call first; paths are relative to the granted root.                                            |
| `env_status {path}`                  | Keys in one file, and which are blank.                                                                                             |
| `compare_env {left, right, ignore?}` | Drift receipt, source → target. Classes: `same`, `changed`, `missing` (in left only), `extra` (in right only), `blank`, `ignored`. |
| `dry_run_plan {left, right}`         | Per-key `add` / `update` / `keep` / `review`. Descriptive only.                                                                    |

## Workflow

1. `list_projects` → pick the project matching the repo you are in (compare `rel` to the cwd).
2. Pick a pair. Convention: **left = the reference** (usually `.env.example` or `.env`),
   **right = the environment being checked** (`.env.production`, `.env.staging`, …).
3. `compare_env`. Report `missing` and `blank` keys first: those break deploys. `changed` is
   expected between environments unless the key is configuration that should match. `extra`
   is informational; Drift never removes keys.
4. Only if the user wants to act: `dry_run_plan` and present it as a checklist. Drift has no
   apply step yet and you cannot sync anything; the user edits the target file themselves. Do
   not edit `.env*` files to "fix" drift unless the user explicitly asks you to edit a
   specific file, and never write a value you were not given in the conversation.

## Rules

- Never request, guess, log or echo a secret value. Key names only.
- If `list_projects` fails with "No workspace granted", tell the user to open Drift and
  choose the folder. Do not look for `.env` files yourself as a workaround.
- `NODE_ENV` is ignored by default. Pass `ignore` for other keys that legitimately differ.
- Keep reports short: a table of key → class, then one line per action the user should take.
