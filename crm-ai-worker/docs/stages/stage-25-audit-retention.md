# Stage 25 — Audit retention prune + read-only audit view (post-V2 improvement)

Closes final-report Remaining Risks #5 and the "audit retention/prune job +
panel view over audit_logs" deferred item.

## What shipped

1. **Retention prune** (`src/audit/audit-retention.ts`):
   - `AUDIT_RETENTION_DAYS` (optional Wrangler var): unset/empty → 180;
     `"0"` → pruning disabled; positive int → that horizon; garbage/negative
     → **default 180** (a typo fails safe, never prunes more aggressively).
   - `pruneAuditLogs(env, days, now?)` — blunt time-window DELETE
     (`created_at < cutoff`, strict), returns `meta.changes`. Missing table →
     silent 0 (pre-migration stance of writeAuditLog); other D1 errors
     propagate to the caller.
2. **Cron hosting** (`src/index.ts` scheduled): prune runs on every 5-min
   tick **before** the `claimCustomers` early-return — a tick that researches
   nothing still maintains the trail. Non-empty prunes write an `AUDIT_PRUNE`
   audit row (`{pruned, retention_days}`) so the trail records its own
   maintenance; failures are fail-open (logged, research continues).
3. **Read-only view** — `GET /admin/api/audit-logs` (rbac: `audit.read` on
   GET, non-GET → null → 404, no mutation surface):
   - `?limit=` default 100, clamp 1..500; `?before=<created_at>` strict
     cursor (validated `YYYY-MM-DD HH:MM:SS`); `?action=` exact filter.
   - Newest-first; `metadata_json` parsed server-side (`metadata`, null on
     unparseable); **no `ip_hash`/`user_agent_hash`** — the panel answers
     "what happened", not "who sat behind which address".
   - Full page ⇒ `next_before` = last row's timestamp; short page ⇒ null.
4. **Panel page** `/admin/audit` (`AUDIT_PANEL_HTML`): read-only table,
   action filter, cursor "load more", refresh; same Stage 5 escaping
   discipline (every dynamic value through `esc()`); soft auth wall like
   `/admin/keys` (unauthenticated → 200 + login page, never the trail).
5. `wrangler.toml` documents the var (commented `[vars]` block).

## Verification

- `tests/audit-retention.test.ts` — 19 tests: resolver matrix (incl. "0"
  opt-out and typo-fail-safe), strict-`<` boundary survival, missing-table
  no-op, error propagation, 3 scheduled integrations through the real worker
  `scheduled` entry (prune-before-early-return + AUDIT_PRUNE row, "0"
  disables, explodeOn-D1 fail-open), endpoint RBAC (readonly 200 / sender
  403 / anon 401), cursor paging + limit clamps + action filter + malformed
  cursor ignored, POST 404, panel soft wall + authenticated render + 405.
- Full suite: **562/562 (47 files)**; `tsc --noEmit` exit 0.
- Dry-run build: 448.79 KiB / gzip 114.21 KiB.
- `scripts/check-panel.mjs`: **5 panels clean** (AUDIT_PANEL_HTML picked up
  automatically; ids = getElementById targets).

## Notes for the operator

- Retention is on by default (180d) the moment this deploys — no config
  needed; set `AUDIT_RETENTION_DAYS="0"` to keep rows forever.
- AUDIT_PRUNE rows appear in the trail itself (visible in `/admin/audit`);
  they are always younger than the cutoff, so a prune never eats its own row.
