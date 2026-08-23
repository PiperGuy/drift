# Share links: plan (feature #7)

Status: planned, not built. Saved 2026-08-23.

## Promise to keep

Sealed on device before it leaves · expires by time or open count · revocable · recipient decrypts in
the browser with no account · nothing readable on the relay, ever.

## Architecture (system-design.md §6)

1. **Seal in the app (main).** Pick a file (or a subset of keys). Main reads it, generates a random
   256-bit key, AES-256-GCM encrypts the bytes with a random IV. The key never touches the relay: it
   travels in the URL fragment (`#k=…`), which browsers do not send to servers.
2. **Relay = one Cloudflare Worker + KV** (~150 lines).
   - `POST /s` ciphertext + policy `{ttlSeconds, maxOpens}` → `{id, revokeToken}`
   - `GET /s/:id` → ciphertext; decrements opens; 410 when exhausted, expired or revoked
   - `DELETE /s/:id` with the revoke token
   - KV TTL enforces expiry server-side; open count is a KV counter. No accounts, no plaintext.
3. **Recipient page** on the same Worker (`/o/:id`): static HTML, fetches ciphertext, decrypts with
   WebCrypto from the fragment, shows keys with Copy / Download `.env`. Any browser, no install.
4. **App side.** Share page: pick file, expiry (1h / 24h / 7d), max opens (1 / 5 / unlimited),
   optional excluded keys → link on the clipboard. Local `shares` table (id, path, created, expires,
   maxOpens, revokedAt, revokeToken sealed by keyring) → list with Revoke and live status. Events
   `share_created` / `share_revoked`, key names only.

## Threat model

Anyone with the full link can read the env until it expires or burns; the link is the secret and the
UI says so. The relay operator sees only ciphertext and a counter. Lost link + lost revoke token =
wait for the TTL.

## Needs from Plumbr

Cloudflare account, `wrangler deploy` (free tier), a hostname such as `share.theplumbr.com`, one
config line in the app. Until then the Share page stays roadmap.

## Effort

Worker + recipient page ≈ half a day; app side ≈ a day; plus Codex review. Start with the Worker as
its own small repo (`plumbr-relay`) since it deploys separately.
