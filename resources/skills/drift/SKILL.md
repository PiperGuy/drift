---
name: drift
description: Check and fix environment variable drift between .env files and platform environments (local, SSH, Docker, Vault, Vercel, Railway, Render, Coolify, GitHub Actions, Dokploy, AWS) using the Drift MCP server. Use when the user asks whether envs are in sync, what keys are missing before a deploy, to compare two projects or sources, or to sync approved keys from one environment to another. Never asks for or reveals secret values.
---

# Drift — env drift for coding agents

Drift (by Plumbr) exposes the user's env files and platform environments as **key names, drift
classes and counts only**. You will never see a value, and you cannot write one: a sync is a plan
the user reviews, a dialog they click in the Drift app, then an `apply_sync` call the app executes itself.
Treat every answer as a redacted receipt and keep it that way: do not ask the user to paste values
into the chat.

## Tools

| Tool                                      | Use it for                                                                                                                                                          |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_sources`                            | Every source Drift remembers (folders, SSH, Docker, Vault, platforms) with root, label, workspace, projects and env-file names. Needs the app open. Call first.     |
| `compare_projects {left, right}`          | Project A on source A vs project B on source B. Each side is `{root, project}`. Files are paired by their path inside the project; you get per-pair drift counts.   |
| `create_sync_plan {left, right, ignore?}` | One file pair, `{root, path}` each, left = reference, right = target. Returns an opaque `plan_id`, key names with `add` / `update` / `review` / `keep`, and counts. |
| `request_sync_approval {plan_id, keys}`   | The app shows the user a native dialog with source, target and exactly these keys. Their click returns a one-use `approval` token; Cancel returns an error.         |
| `apply_sync {plan_id, keys, approval}`    | Writes those keys of the plan, inside the app, with the token the user's click minted. Returns written and skipped key names, verification and a snapshot.          |
| `list_projects`                           | Folder, SSH and Docker roots of the active workspace, without the app open. Paths are relative to the root.                                                         |
| `env_status {path}`                       | Keys in one file of those roots, and which are blank.                                                                                                               |
| `compare_env {left, right, ignore?}`      | Drift receipt inside one root. Classes: `same`, `changed`, `missing` (in left only), `extra` (in right only), `blank`, `unknown`, `ignored`.                        |
| `dry_run_plan {left, right}`              | Per-key `add` / `update` / `keep` / `review` inside one root. Descriptive only.                                                                                     |

## Workflow

1. `list_sources` → find the source and project matching the repo you are in (compare `rel` and
   the project name to the cwd), and the environment the user is asking about.
2. To see the whole picture: `compare_projects` with the reference project on the left and the
   environment being checked on the right. Report pairs that are not `clean`, then files only on
   one side.
3. To dig into one pair, or to sync: `create_sync_plan`. Convention: **left = the reference**
   (usually the folder's `.env` or `.env.example`), **right = the environment being checked**
   (`.env.production`, Vercel production, a Vault secret, …). Report `add` (missing on the
   target) and `review` (blank or unreadable on one side) first: those break deploys. `update` is
   expected between environments unless the key is configuration that should match. `keep` is
   informational; Drift never removes keys.
4. Only after the user has read the plan and named the keys to sync: `request_sync_approval`
   with that `plan_id` and exactly those keys, each once. The user confirms in the Drift window;
   if they cancel, stop and say so. Then `apply_sync` with the same `plan_id`, the same keys in
   the same order, and the `approval` token. Never call either unprompted, never widen the key
   list, never loop on a declined dialog, never retry with a plan or token that failed: make a
   new plan and show it again. Plans expire after 15 minutes, approvals after 5, and each works once.
5. Report what `apply_sync` returned: written keys, skipped keys with their reason, whether the
   target read back correctly, and the note (deployment effects such as "redeploy to pick up").

## Rules

- Never request, guess, log or echo a secret value. Key names only.
- If a tool says Drift is not running, locked or a source was removed, tell the user to open the
  Drift app (and unlock or re-add the source). Do not look for `.env` files or credentials
  yourself as a workaround.
- Never edit `.env*` files yourself to "fix" drift; the user either approves a plan or edits the
  file themselves. Never write a value you were not given in the conversation.
- `NODE_ENV` is ignored by default. Pass `ignore` for other keys that legitimately differ.
- Keep reports short: a table of key → class, then one line per action the user should take.
