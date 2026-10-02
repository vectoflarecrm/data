# Stage 3 Report — Remove Worker Self-Secret Management

Branch: `feature/security-v2` · Follows: Stage 2 (RBAC)

## Goal
A production Worker must not hold the capability to rewrite its own production
secrets. Before this stage, `/admin/api/secrets/*` + the `/admin/secrets`
panel used a Cloudflare API token stored *as a Worker secret* to PUT arbitrary
secret values onto the Worker itself (bootstrap even stored the API token that
granted that power). Any admin compromise → full secret rewrite, including
`ADMIN_PANEL_TOKEN` itself. This is baseline P0 #3.

## Removed (src/admin.ts, −297 lines)
- `handleSecretsApi()` — bootstrap / GET definitions / bulk update, and its
  Cloudflare API client `cfPutWorkerSecret()`, `secretApiConfig()`, the
  `SECRET_DEFINITIONS` catalog + `secretDefinitionsExpanded()` (~180 lines).
- `/admin/api/secrets` router wiring — the path now falls through to the
  router's 404 for **every** role.
- `/admin/secrets` panel page + `SECRETS_PANEL_HTML` (~92 lines), and the
  `🔑 AI Key 管理` nav link in the main panel header.
- `AdminEnv` fields `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` /
  `WORKER_SCRIPT_NAME` — the runtime no longer reads them at all.

## Removed (src/auth/rbac.ts)
- The `secrets.write` permission, the super_admin grant, and the
  `/admin/api/secrets` route branch. A code comment documents the removal so
  the path is not silently re-added later.

## Replacement (spec 4.2)
- **docs/secret-management.md** (new): the three sanctioned channels —
  Cloudflare Dashboard, `wrangler secret put`, CI/CD (GitHub Actions env
  secrets + the opt-in `SYNC_SECRETS_FROM_GITHUB` gate) — plus a where-things-
  live table and post-upgrade cleanup (`wrangler secret delete
  CLOUDFLARE_API_TOKEN …` for previously bootstrapped deployments).

## Docs kept honest
- README: route table, key-management "三种方式"→"两种方式" (panel direct-write
  section replaced by a historical note + link to the new doc), env-secret
  list dropped `CLOUDFLARE_API_TOKEN/CLOUDFLARE_ACCOUNT_ID`.
- deploy-worker.yml: two stale comments now point at the `/admin/keys` D1
  pool. CI **behavior unchanged** (its `CLOUDFLARE_API_TOKEN` is the *deploy*
  credential of the runner, never a Worker runtime secret).

## Tests
- `tests/rbac.test.ts` updated — the spec's stage-2 invariant "only
  super_admin can manage secrets" is superseded by the stronger stage-3
  invariant: **nobody** can; `/admin/api/secrets`, `/admin/api/secrets/update`,
  `/admin/api/secrets/bootstrap` and the `/admin/secrets` page return 404 for
  all five roles including super_admin. No other suite referenced the
  endpoints.
- 197/197 pass (count unchanged; two secrets tests rewritten, one merged).

## Verification
- `npm run typecheck`: pass
- `npm test`: **197/197 pass**
- `node scripts/check-panel.mjs`: 4 panels clean (5th panel gone by design)
- `npx wrangler deploy --dry-run` (offline): pass

## Security Risks Fixed
- Baseline P0 #3: admin compromise no longer implies production secret
  rewrite; the Worker holds zero Cloudflare API credentials at runtime, so the
  "panel writes its own secrets" escalation path is structurally gone.

## Backward Compatibility
- Operators who used the panel for key rotation move to `/admin/keys` (D1
  pool, already the recommended path) or the three documented channels.
- Previously bootstrapped `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID`/
  `WORKER_SCRIPT_NAME` Worker secrets become inert; the doc shows how to
  delete them.
- No business tables, migrations, or API route shapes changed beyond the
  removed surface.

## Remaining Risks
- `/admin/keys` (D1 pool) remains the in-panel credential surface; its
  hardening is Stage 4 (credential encryption V2) and Stage 5 (panel XSS fix,
  security headers).
