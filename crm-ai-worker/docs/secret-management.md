# Secret Management

> Security V2 Stage 3. The production Worker **no longer manages its own
> Cloudflare Worker secrets**. The `/admin/secrets` page and the
> `/admin/api/secrets/*` endpoints were removed: a compromised admin session
> must not be able to rewrite the Worker's production secrets (including the
> very `ADMIN_PANEL_TOKEN` that guards the panel, or a
> `CLOUDFLARE_API_TOKEN` with `Workers Scripts: Edit` that would allow
> redeploying the Worker entirely).

Worker secrets are changed through exactly one of these three channels:

## 1. Cloudflare Dashboard (web UI)

Workers & Pages → `crm-ai-worker` → **Settings** → **Variables and Secrets** →
*Add secret* / edit / delete. Takes effect on the next request, no redeploy
needed. Suitable for one-off changes from a laptop with dashboard access.

## 2. `wrangler` CLI (local terminal)

```bash
npx wrangler secret put GEMINI_API_KEY          # prompts for the value
npx wrangler secret put CREDENTIAL_ENC_KEY      # 32-byte base64 encryption key
npx wrangler secret list                        # names only — values are never readable back
npx wrangler secret delete OLD_SECRET_NAME
```

Requires a local Cloudflare login
(`npx wrangler login` or `CLOUDFLARE_API_TOKEN` env var — a **deploy**
credential, kept on your machine, never given to the Worker itself).

## 3. CI/CD (GitHub Actions environment secrets)

Repo **Settings → Secrets and variables → Actions** holds the values; the
deploy workflow (`.github/workflows/deploy-worker.yml`) writes them with
`wrangler secret put` on deploy.

- By default the sync is **opt-in**: set the repo secret
  `SYNC_SECRETS_FROM_GITHUB=true` to force-sync the whole declared list.
  ⚠️ That step also **deletes** Worker secrets absent from the list — read the
  workflow before enabling.
- `ADMIN_PANEL_TOKEN` is always synced from GitHub (source of truth for the
  login credential, so a rotation can be done from the repo UI).

## What lives where

| Secret | Managed via | Notes |
|---|---|---|
| `ADMIN_PANEL_TOKEN` | GitHub (auto-synced each deploy) | Panel login; rotation in repo UI |
| `CREDENTIAL_ENC_KEY` | Dashboard / wrangler | D1 credential encryption; back up D1 first — no backup, no recovery |
| `*_API_KEY`, `*_MODEL`, `*_RPM` env fallbacks | Dashboard / wrangler / opt-in CI sync | The **preferred** place for provider keys is the `/admin/keys` D1 pool (encrypted at rest, instant effect, per-key cooldown) |
| Gmail `GMAIL_SERVICE_ACCOUNT_*` / `GMAIL_SENDER_EMAIL` | Dashboard / wrangler | Per-account Gmail credentials can also live (encrypted) in the `/admin/keys` Gmail sender pool |

## Cleanup after upgrading past Stage 3

If the removed panel was ever bootstrapped on your Worker, delete its now
unused runtime secrets — they are dead weight and an unnecessary standing
privilege:

```bash
npx wrangler secret delete CLOUDFLARE_API_TOKEN
npx wrangler secret delete CLOUDFLARE_ACCOUNT_ID
npx wrangler secret delete WORKER_SCRIPT_NAME   # only if you ever set it
```

A leaked `CLOUDFLARE_API_TOKEN` with `Workers Scripts: Edit` would allow an
attacker to rewrite every secret of this Worker — that is precisely the
capability Stage 3 removed from the request path.
