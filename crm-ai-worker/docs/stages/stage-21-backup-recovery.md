# Stage 21 — Backup / Recovery (spec §22)

**Status: complete.** Commit: `security-v2: add backup and recovery documentation`
Test surface: unchanged — 403/403, tsc clean, dry-run unchanged, 4 panels clean (documentation-only stage; no code touched).

## What the spec asked for (§22, 架构.txt L1443-1462)

Create `docs/backup-recovery.md` defining D1 backup, migration backup, credential recovery, campaign recovery and research recovery, with explicit RPO/RTO — and the standing rule: **不要假设 D1 本身就是完整备份策略**.

## Deliverable

`crm-ai-worker/docs/backup-recovery.md` (new) — the operator-facing strategy document:

- **Inventory first**: every asset mapped to location / backup / restore path — the 24 D1 tables grouped by criticality, Wrangler + CI secrets (outside git and D1 by design, Stage 3), code in git, and the external sources of truth (provider consoles, Google Cloud Console, Gmail Sent folder) that make most assets RPO-0.
- **D1 backup**: Time Travel facts verified against current Cloudflare docs (automatic bookmarks; 30-day window on Workers Paid / 7-day on Free; `time-travel info/restore`; restore is destructive-and-in-place and prints an undo bookmark), plus `wrangler d1 export` as the off-platform leg, with export caveats (blocks queries, 5 GiB import limit, no virtual tables).
- **Migration backup**: the deploy workflow runs `schema.sql` on remote prod on every push, so a bad schema change hits at deploy time — pre-deploy bookmark recording is mandated; the migration-accident runbook is revert → redeploy → Time Travel restore → verify → re-apply.
- **Credential recovery**: the `enc:v1:` ciphertext is useless without `CREDENTIAL_ENC_KEY` and the key is useless without the rows — both failure directions recover via panel re-entry from provider consoles; `key_hint` identifies keys without revealing them; rotation path documented.
- **Campaign recovery**: maps the Stage 10/11/12 state machine to crash scenarios — `reserved` reaper returns to draft (auto-retry), `sending` becomes `uncertain` (never auto-retried; operator checks Gmail Sent and resolves), idempotency_key blocks duplicate sends after a restore, quota reservations and campaign locks self-heal via TTL reapers; post-restore verification query included. RTO ≤ one cron tick (5 min) for automatic paths.
- **Research recovery**: a crash leaves an orphaned `running` row that is cosmetic; recovery is panel reset → `pending` → new run, with evidence-v2 supersession (`is_current`/`valid_from`/`valid_until`) and preserved provenance.
- **RPO/RTO contract table**: per component, with the honest schedule note that the weekly off-platform export is the *only* protection beyond the Time Travel window, and the quarterly restore-drill rule ("a backup that has never been restored is a hypothesis, not a backup").
- **Runbooks**: Time Travel restore (with forensics export first and undo-bookmark recording), fresh-environment recovery (account lost: new D1 + secrets from password manager + import + re-enter credentials + CI redeploy), and the quarterly drill commands.

## Decisions

- **Documentation deliverable only** — the spec asks for the document; the backup *schedule* (weekly export, pre-deploy bookmarks, quarterly drills) is codified as the operator contract rather than automated in CI, because automation would need a new D1-write-capable token path and artifacts policy that §22 does not ask for. The doc names Cloudflare's documented Workflows→R2 export pattern as the upgrade path when the manual cadence outlives its usefulness.
- **Facts verified against live Cloudflare docs** (Time Travel reference + import/export guide) rather than memory — restore semantics (in-place, destructive, undo bookmark) and window lengths (30d paid / 7d free) materially shaped the runbooks.
- **The spec's standing rule is the document's spine**: Time Travel is same-account/same-control-plane and cannot survive account loss, a destructive restore itself, or a lost `CREDENTIAL_ENC_KEY` — hence off-platform exports + external re-entry paths + git are the three legs D1 cannot stand on.
- Recovery semantics for campaigns and research are taken from the actual Stage 10-14 implementations (state machine, reapers, idempotency, evidence supersession), not generic advice.
- No baseline entry touched — backup/recovery was a spec deliverable, not one of the numbered findings.

## Verification

- `npx tsc --noEmit` — clean (no code changed).
- `npx vitest run` — 403/403 (28 files), unchanged.
- `npx wrangler deploy --dry-run` — bundle unchanged from Stage 20 (439.04 KiB).
- `node scripts/check-panel.mjs` — 4 panels clean.
