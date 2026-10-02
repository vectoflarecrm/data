# Stage 12 Report — Campaign Concurrency Lock

Branch: `feature/security-v2` · Follows: Stage 11 (quota reservation)

## Goal (spec §13)
Stages 10/11 made the per-email claim and the per-quota-slot claim atomic, so
concurrent workers can no longer double-send an email or overshoot the daily
cap. What remains is the campaign-level race: two workers executing the SAME
campaign interleave their loops — double-spending AI tokens in the generate
step and burning quota on members the other worker already owns. Stage 12
makes campaign execution single-flight: one campaign, at most one runner.

## Changes

### `migrations/0011_campaign_locks.sql` (new) + `schema.sql`
`campaign_locks` (`campaign_id` PK, `lock_token`, `locked_at`, `expires_at`) —
one row per campaign while a worker holds it. New table → CI's schema.sql run
creates it on existing databases automatically; no deploy-workflow ALTER step
needed (same as Stages 9/11).

### `src/campaign-lock.ts` (new)
- **`acquireCampaignLock` (§13.1's atomic claim)** — one upsert:
  `INSERT … ON CONFLICT(campaign_id) DO UPDATE SET … WHERE
  campaign_locks.expires_at <= now`. A fresh INSERT lands when no row exists,
  an **expired** lock is stolen in place, and a **live** lock yields
  `changes === 0` → caller is told the campaign is busy. No read-then-write
  window at any concurrency.
- **Release is token-guarded**: `DELETE … WHERE campaign_id = ? AND
  lock_token = ?` — a worker whose lock expired (and was stolen) can never
  delete the new holder's row. Release failures are swallowed: a stuck row is
  recovered by TTL steal, not by a crashing `finally`.
- **TTL 30 min** (default; `CAMPAIGN_LOCK_TTL_MS` override, 60s floor): sized
  above the worst legal send batch (50 × (3s delay + 30s Gmail timeout) ≈
  28 min), so a live batch can never have its lock stolen mid-run.
- **Fail-open on a missing table** — deliberately the opposite of Stage 11's
  fail-closed quota: the lock is defense-in-depth *on top of* Stage 10's
  hard per-email guarantees (see tests), so a migration-pending database
  proceeds unlocked rather than breaking sends. Any other DB error throws.

### `src/campaigns.ts`
- `runCampaignGenerate` and `runCampaignSend` acquire the lock after the
  paused-campaign guard and release it in `finally` — generate and send take
  the **same** lock, so a generate click cannot interleave with a send batch
  on one campaign either. A refused acquire throws `CampaignLockedError`
  with a message that explains the TTL self-heal.
- `runCampaignSend` now recognizes the state machine's `skipped_locked`
  outcome and leaves that member on `generated` (counted as `skipped`)
  instead of burning it as `failed`: the email is owned by another execution
  (an operator's single-send racing the batch, or the fail-open window), and
  that owner marks the member when it finishes. This also fixes a latent
  misreport: without it, a single-send click during a batch could leave a
  successfully-sent member recorded as `failed`.

### `src/admin.ts`
`handleCampaignApi` maps `CampaignLockedError` to **409** with the actionable
detail message — the panel toast says "正在被另一个执行处理…请稍后重试"
instead of a 500. Reads (campaign detail, member list) never take the lock.

## Tests (+8 → 324 total)
`tests/campaign-lock.test.ts`:
- **§13.1 primitives**: acquire → second acquire refused → release →
  re-acquirable; **expired lock stolen atomically and the stale holder's
  release cannot delete the fresh holder's row**; `CAMPAIGN_LOCK_TTL_MS`
  override; missing table → fail-open lock.
- **§13.2 verbatim (with the lock)**: 100 members, **10 concurrent send
  workers → exactly 1 fulfills, 9 reject with `CampaignLockedError`**;
  the winner sends one capped batch of 50; the lock row is gone after
  (finally released); draining sequentially ends with **every email sent
  exactly once** and every member `sent`.
- **§13.2 in the fail-open window** (no `campaign_locks` table): all 10
  workers proceed and race per-email — **no email reaches the transport
  twice** (call log distinct), **no member is misreported `failed`**, and
  the drain still ends 100-for-100. Proves the "at most once" guarantee is
  Stage 10's, and the lock only removes the duplicated work.
- **Generate step takes the same lock**: two concurrent generates → 1 runs,
  1 `CampaignLockedError`; a foreign held lock blocks both send and
  generate until released.
- **Admin surface**: `POST /campaigns/:id/send` and `/generate` return **409**
  while another worker holds the lock, the foreign lock row is untouched, and
  campaign reads stay 200.

## Verification
- `npx tsc --noEmit`: pass
- `npm test`: **324/324 pass** (was 316, +8; 21 files)
- `node scripts/check-panel.mjs`: 4 panels clean
- `npx wrangler deploy --dry-run` (offline): pass

## Security Risks Fixed
- Baseline **#5 (P0)** — completed. The per-email half ("double-send one
  email") was already closed by Stage 10's atomic claims; Stage 12 closes the
  campaign half: concurrent executions of one campaign are now impossible,
  so AI tokens and quota are not burned on duplicated work, and member
  bookkeeping cannot be raced into lying about outcomes.

## Notes and boundaries
- **Fail-open vs fail-closed is a policy, not an accident**: quota control
  (Stage 11) fails closed because degrading it means overshooting Gmail's
  cap; the campaign lock fails open because the hard send guarantees live
  one layer below it, and refusing all campaign sends over a missing
  optimization table would be an availability loss for no safety gain.
  Production never sees the window anyway — CI creates the table via
  schema.sql before the new code deploys.
- The lock covers the two admin-triggered campaign steps only; per-email
  endpoints (single send, send-batch) intentionally do NOT take it — they
  are bounded by Stage 10/11 claims, and a stuck campaign lock must not
  block individual email retries.
- A crashed worker's lock self-heals after the TTL (30 min) via
  steal-on-acquire; there is no reaper cron because the table is only ever
  consulted at acquire time.
