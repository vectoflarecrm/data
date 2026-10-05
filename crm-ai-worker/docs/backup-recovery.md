# Backup & Recovery — crm-ai-worker

Security V2 Stage 21 (spec §22). This document defines the backup and
recovery strategy for the CRM AI Worker: what is backed up, how, how often,
and how to recover each subsystem.

**核心原则（spec §22）: 不要假设 D1 本身就是完整备份策略。**
D1's built-in Time Travel is a same-account, same-control-plane mechanism.
It does not survive the failure modes that most require a backup: a lost or
compromised Cloudflare account, a destructive `time-travel restore` itself
(the undo path also lives in the same account), or the loss of the
`CREDENTIAL_ENC_KEY` secret (D1 stores only ciphertext it cannot decrypt).
A real backup strategy needs three things D1 cannot provide by itself:

1. **Off-platform exports** — SQL dumps stored outside Cloudflare
   (downloaded to a local/offsite machine), on a schedule.
2. **Re-entry paths for secrets and credentials** — Wrangler secrets and
   provider API keys are re-obtainable from their sources of truth, not
   from D1.
3. **Code and CI configuration in git** — the repo is the source of truth
   for the Worker; a database without the Worker is not a running system.

---

## 1. Inventory — what exists, and where

| Asset | Location | Backed up by | Restored by |
|---|---|---|---|
| Business data (customers, contacts, imports, groups, campaigns, members, emails, outreach settings/attachments) | D1 `crm-ai-db` | Time Travel + off-platform export | Time Travel restore / export re-import |
| Research & evidence (research_runs, evidence) | D1 | Time Travel + export | restore, or **re-run** (source is the public web) |
| Audit trail (audit_logs, request ids) | D1 | Time Travel + export | restore (forensics, not operations) |
| Provider API keys (api_configs.api_key, `enc:v1:` ciphertext) | D1 **+** CREDENTIAL_ENC_KEY secret | export is useless without the key — see §4 | re-enter via panel from provider consoles |
| Gmail credentials (gmail_accounts, `enc:v1:` ciphertext) | D1 **+** CREDENTIAL_ENC_KEY | same as above | re-enter via panel from Google Cloud Console |
| Operational/volatile state (api_key_health/usage, gmail_send_log, gmail_send_reservations, campaign_locks, rate_limit_windows, admin_login_attempts, admin_sessions) | D1 | Time Travel (best-effort; all self-healing) | reapers/cron rebuild it; never import-blocking |
| Worker code, schema, migrations | git (`feature/security-v2` → main) | git itself | CI redeploy |
| Wrangler secrets: `ADMIN_PANEL_TOKEN`, `CREDENTIAL_ENC_KEY`, `GEMINI_API_KEY`, `GEMINI_MODEL` (optional), `CAMPAIGN_LOCK_TTL_MS` (optional) | Cloudflare account only — **not in repo, not in D1** (Stage 3 by design) | operator's secret store (password manager) | `npx wrangler secret put <NAME>` |
| CI secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_D1_DATABASE_ID` | GitHub repo settings | operator's secret store | GitHub settings → Secrets |
| Gmail-side truth (sent mail, quota) | Google | Google | Gmail "Sent" folder is the delivery source of truth |

External sources of truth that make recovery cheap: API keys are re-issued
from Google AI Studio / provider consoles; Gmail service-account JSON and
refresh tokens from Google Cloud Console; research evidence is re-fetchable
from the public web. **Nothing in this system is unrecoverable except D1
rows without an export and older than the Time Travel window.**

---

## 2. D1 backup

### 2.1 Time Travel (automatic, in-account, point-in-time)

D1 on the production storage backend keeps automatic bookmarks; restore is
possible to any minute within the last **30 days on the Workers Paid plan /
7 days on the Free plan**. Always on, no cost, no configuration.

```sh
# Confirm the database is on the production backend (version: production)
npx wrangler d1 info crm-ai-db

# Current bookmark (run BEFORE every deploy; record it — see §3)
npx wrangler d1 time-travel info crm-ai-db

# Restore in place (DESTRUCTIVE — overwrites the database; returns an undo bookmark)
npx wrangler d1 time-travel restore crm-ai-db --timestamp="2026-04-01T09:30:00+00:00"
npx wrangler d1 time-travel restore crm-ai-db --bookmark=<bookmark-id>
```

Notes (from Cloudflare docs):

- Restore is **in-place and destructive**; in-flight queries are cancelled.
- The command prints a **previous bookmark** — record it to be able to undo.
- Restoring does not delete older bookmarks; you can go back again.
- Requires Wrangler ≥ 3.4.0 (the repo's wrangler satisfies this).

### 2.2 Off-platform export (the actual backup)

Time Travel lives inside the same Cloudflare account, so it is not
sufficient by itself. Export to SQL and **store the file outside
Cloudflare**:

```sh
# Full logical dump (schema + data)
npx wrangler d1 export crm-ai-db --remote --output=./backup-$(date +%Y%m%d).sql

# Restore a dump into a fresh database (see runbook §8.3)
npx wrangler d1 execute crm-ai-db --remote --file=./backup-YYYYMMDD.sql
```

Export caveats: a running export blocks other database requests (export at
a quiet hour); virtual tables cannot be exported (this schema has none);
imports are limited to 5 GiB per file (this database is far below).

### 2.3 Schedule (the RPO knob)

| When | Action |
|---|---|
| Before every deploy (`git push` to main) | Record the Time Travel bookmark next to the release (deploy summary / release notes). RPO for migration accidents = 0. |
| Weekly | `wrangler d1 export` → move the `.sql` off-platform (operator's machine / offline storage), keep ≥ 4 weekly copies. |
| After any bulk import (CSV upload) or credential batch change | Immediate export. |
| Quarterly | Restore drill: import the newest export into a scratch `wrangler d1 create backup-drill` database, verify row counts, delete it. A backup that has never been restored is a hypothesis, not a backup. |

---

## 3. Migration backup

The deploy workflow (`.github/workflows/deploy-worker.yml`) executes
`schema.sql` against **remote production on every deploy**, followed by
idempotent column backfills and index creation (`|| true` / WARNING
tolerance patterns — see the Stage 10/17 workflow steps). Consequences:

- A bad schema change reaches production **at deploy time**, not later.
  Schema discipline (idempotent `IF NOT EXISTS`, additive-only changes,
  `migrations/NNNN-*.md` documenting every step) is the first line of
  defense.
- The rollback for a schema accident is: `git revert` → redeploy →
  Time Travel restore to the pre-deploy bookmark if rows were damaged.
  This only works if the bookmark was recorded — hence the pre-deploy
  rule in §2.3.
- `migrations/` is the paper trail of every intentional schema change;
  `schema.sql` is the current shape. Both live in git and are therefore
  covered by the repo's own backup (the git remote).

Migration runbook (accidental data-changing migration):

1. Record proof: `npx wrangler d1 export crm-ai-db --remote --output=./pre-fix.sql` (post-mortem forensics).
2. `npx wrangler d1 time-travel info crm-ai-db` → restore to the pre-deploy bookmark (`--timestamp` works too).
3. `git revert <bad-commit>`; push — CI redeploys the old (correct) schema.
4. Verify: panel row counts, `SELECT COUNT(*) FROM customers;`, one audit row read.
5. Re-apply the intended migration once fixed, with a fresh pre-deploy bookmark recorded.

---

## 4. Credential recovery

Credentials at rest are `enc:v1:<iv>:<ciphertext>` (Stage 4, AES-GCM via
`CREDENTIAL_ENC_KEY`). D1 without the key is noise; the key without D1 is
useless. Both failure directions are recoverable **without any backup**,
because the plaintexts are re-obtainable:

| Failure | Impact | Recovery |
|---|---|---|
| `CREDENTIAL_ENC_KEY` lost/deleted | All `enc:v1:` rows undecryptable — AI calls and Gmail sending fail | Re-enter each key in the panel (KEYS panel for provider keys; GMAIL panel for service accounts / refresh tokens). `key_hint` in each row identifies which key is which without revealing it. New entries encrypt under the (new) key; old ciphertext rows get replaced on save. |
| `CREDENTIAL_ENC_KEY` rotated intentionally | Nothing breaks if done as below; old rows stay readable via the fallback | **Automated rotation (post-V2):** 1) `npx wrangler secret put CREDENTIAL_ENC_KEY_PREVIOUS` = old key; 2) `npx wrangler secret put CREDENTIAL_ENC_KEY` = new key, deploy; 3) `POST /admin/api/keys/reseal` and `POST /admin/api/gmail/reseal` (super_admin) — the sweep re-encrypts every row onto the new key and reports `resealed` / `already_current` / `failed`; 4) verify `failed` empty and `plaintext_remaining: 0`, check the trail in `/admin/audit`; 5) `npx wrangler secret delete CREDENTIAL_ENC_KEY_PREVIOUS`, redeploy. If the old key is already gone (no PREVIOUS possible), fall back to panel re-entry as above. |
| Provider API key revoked/expired | That provider's calls fail | Issue a new key in the provider console, save via panel. Health/usage tables (`api_key_health`, `api_key_usage`) track the fallout. |
| Gmail service account / refresh token revoked | Gmail sending halts (quota reservation fail-closed per account) | Re-create in Google Cloud Console, re-enter via panel. |
| WebAuthn security key lost (2FA active) | Panel login still possible with a recovery code | Log in (token → 恢复码), then register a replacement key in `/admin/security`. Each code burns on use; a valid session can also regenerate the whole set (`WEBAUTHN_RECOVERY_REGEN` — old codes all die). |
| WebAuthn key AND all recovery codes lost | Operator locked out of the panel; Bearer path is closed while a credential row is active | Break-glass, D1-only: `npx wrangler d1 execute <db> --remote --command "UPDATE webauthn_credentials SET revoked_at = CURRENT_TIMESTAMP"` — with zero active credentials 2FA is off and token login (and Bearer) work again. This is a last resort: it bypasses the audit trail, so re-register a key immediately after logging in. A Time Travel restore to a pre-enrollment bookmark has the same effect but also reverts other data — prefer the UPDATE. |
| `WEBAUTHN_RP_ID` unset/typo'd after enrollment | 2FA silently dormant (login single-factor, credential rows ignored) | Fix the var and redeploy — credential rows are still valid, 2FA re-arms automatically. A typo'd RP ID or missing origin in `WEBAUTHN_ORIGINS` instead makes asserts fail (`origin_rejected`/`rpid_mismatch`) — check `/admin/audit` (LOGIN_FAILED rows carry the reason). |
| D1 rows lost (pre-Time-Travel-window) | Credential set lost | Re-enter from provider consoles / Google Cloud Console. This is why credentials are RPO-0 in §7: their source of truth is external. |

Rules: never store plaintext credentials outside their source console
(password manager entry for `CREDENTIAL_ENC_KEY` and `ADMIN_PANEL_TOKEN`
is the operator's responsibility — they are not in git or D1 by design).

---

## 5. Campaign recovery

Sending state is a D1 state machine (Stage 10/11/12) and is designed to
self-heal after any crash, deploy or restore:

```
draft ──claim──▶ reserved ──▶ sending ──Gmail──▶ sent
                    │            └─ unknown outcome ─▶ uncertain
```

- **Worker died before the Gmail call** (`reserved`, lock older than the
  TTL): the next cron tick's reaper returns the row to `draft` — it is
  retried automatically.
- **Worker died during/after the Gmail call** (`sending`): the outcome is
  unknown, so the row becomes `uncertain` and is **never auto-retried** —
  a re-send could duplicate the email. The operator checks Gmail's "Sent"
  folder for that recipient: if sent, mark resolved in the panel; if not,
  reset the row to `draft` for a clean retry.
- **Double-send protection**: `outreach_emails.idempotency_key` (unique
  partial index) — a retry after restore cannot create a second send row
  for the same message.
- **Quota reservations** (`gmail_send_reservations`): orphaned `reserved`
  slots are deleted by the TTL reaper; quota is fail-closed, so a lost
  reservation never over-sends, it just re-frees capacity after the TTL.
- **Campaign locks** (`campaign_locks`): expired locks (default TTL 30
  min) are stealable by the next batch attempt — no manual unlock needed
  after a crash.
- **After a Time Travel restore**: sends that happened after the restore
  point but before the crash may reappear as `draft`. The idempotency key
  blocks duplicate rows; the `uncertain` discipline above covers the rest.
  Recommended: after any restore, query
  `SELECT id, status, locked_at, send_attempts FROM outreach_emails WHERE status IN ('reserved','sending','uncertain') ORDER BY updated_at DESC`
  and resolve before resuming campaign batches.

RTO for campaign resumption after a crash: **one cron tick (≤ 5 minutes)**
for the automatic paths; manual `uncertain` resolution is the operator's
cadence.

---

## 6. Research recovery

Research is re-derivable by design (Stage 14 evidence-v2):

- A crash mid-research leaves the `research_runs` row stuck at `running`.
  Orphaned `running` rows are **cosmetic** — the authoritative signals are
  `customers.status` (work-to-do) and `evidence.is_current` (truth).
- To redo a customer's research: reset it to `pending` (panel research
  action → `UPDATE customers SET status = 'pending'`); the next cron run
  opens a **new** `research_runs` row and supersedes evidence via
  `is_current` / `valid_from` / `valid_until` — no cleanup of the orphan
  is required (optionally mark it `failed` for hygiene).
- Evidence is re-fetchable from the public web; a restore that loses
  evidence rows costs one re-run, not data.
- Provenance (`parser_version`, `model_name`, `model_version`,
  `source_hash`, `content_hash`) survives in both the runs and evidence
  tables, so post-restore evidence remains auditable.

---

## 7. RPO / RTO (the contract)

| Component | RPO (max data loss) | Why | RTO (max downtime) | How |
|---|---|---|---|---|
| D1 business data | ≤ 7 days with **weekly export only** (see schedule note); ≤ minutes-to-0 for in-window accidents via Time Travel | Time Travel window (7d free / 30d paid) + weekly off-platform export | ≤ 1 h | Time Travel restore (minutes) or export re-import into a fresh DB |
| Provider API keys | 0 | Source of truth is the provider console | minutes per key | Panel re-entry |
| Gmail credentials | 0 | Source of truth is Google Cloud Console | minutes per account | Panel re-entry |
| Wrangler / CI secrets | 0 | Source of truth is the operator's password manager | minutes | `wrangler secret put` / GitHub settings |
| Campaign state (in-flight sends) | 0 (no double-send: idempotency + uncertain discipline) | State machine in D1 + reapers | ≤ 5 min (automatic paths) | Cron reapers; manual for `uncertain` |
| Research / evidence | same as D1 business data — but re-derivable from the web | evidence-v2 supersession | one rerun cycle | Panel reset → cron |
| Worker code | 0 | git | minutes | CI redeploy |
| Audit trail | same as D1 | append-only in D1 | ≤ 1 h | restore (forensic priority, not operational) |

Schedule note: the weekly export is the **only** protection against losing
data older than the Time Travel window. If the database ever outgrows a
comfortable manual cadence, automate the export (Cloudflare's
[Workflows-based D1→R2 export](https://developers.cloudflare.com/workflows/examples/backup-d1/)
is the documented pattern) — until then the manual cadence above is the
contract, and the quarterly restore drill (§2.3) proves it.

---

## 8. Runbooks

### 8.1 Time Travel restore (bad deploy / bad migration / data accident)

```sh
npx wrangler d1 export crm-ai-db --remote --output=./pre-restore-$(date +%Y%m%d).sql   # forensics
npx wrangler d1 time-travel info crm-ai-db                                              # current bookmark
npx wrangler d1 time-travel restore crm-ai-db --timestamp="<pre-incident RFC3339>"
# ⚠ record the "previous bookmark" the command prints — that is the undo path
```

Then: verify row counts via panel; resolve `reserved`/`sending`/`uncertain`
sends (§5); expect admin sessions to be invalidated (they reference rows
now in the future — re-login is normal and safe).

### 8.2 Fresh-environment recovery (account lost / starting over)

1. New Cloudflare account + D1 database; update `database_id` locally (never commit it — CI injects `CLOUDFLARE_D1_DATABASE_ID`).
2. `npx wrangler secret put ADMIN_PANEL_TOKEN` and `CREDENTIAL_ENC_KEY` (from the password manager), `GEMINI_API_KEY`, optional `GEMINI_MODEL` / `CAMPAIGN_LOCK_TTL_MS`.
3. Import the newest off-platform export: `npx wrangler d1 execute <db> --remote --file=./backup-YYYYMMDD.sql` (if the dump's `CREATE TABLE` conflicts with a schema.sql already applied, restore into an empty DB — the dump carries its own schema).
4. Re-enter provider keys and Gmail credentials if `CREDENTIAL_ENC_KEY` changed (§4).
5. Push to main — CI deploys and re-asserts the schema (idempotent).

### 8.3 Verify a backup (quarterly drill)

```sh
npx wrangler d1 create backup-drill
npx wrangler d1 execute backup-drill --remote --file=./backup-YYYYMMDD.sql
npx wrangler d1 execute backup-drill --remote --command "SELECT COUNT(*) FROM customers;"
npx wrangler d1 execute backup-drill --remote --command "SELECT COUNT(*) FROM outreach_emails;"
npx wrangler d1 delete backup-drill
```

---

*Stage 21 deliverable per spec §22 (架构.txt L1443-1462): D1 backup,
migration backup, credential recovery, campaign recovery, research
recovery, explicit RPO/RTO — with the standing rule that D1 itself is not
assumed to be a complete backup strategy.*
