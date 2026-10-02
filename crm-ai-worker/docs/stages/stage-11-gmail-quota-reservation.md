# Stage 11 Report — Gmail Quota Atomic Reservation

Branch: `feature/security-v2` · Follows: Stage 10 (sending state machine)

## Goal (spec §12)
Quota used to be check → send → increment: a count read that 100 concurrent
workers could all interpret as "slots available" before any of them wrote
anything. Racing batches could overshoot the daily cap — for a Gmail pool
that means account suspension. Stage 11 turns capacity taking into a single
atomic statement: reserve → send → commit.

## Changes

### `migrations/0010_gmail_quota_reservations.sql` (new) + `schema.sql`
`gmail_send_reservations` with the spec §12.1 DDL verbatim (`id`,
`gmail_account_id`, `idempotency_key UNIQUE`, `reserved_at`, `expires_at`,
`status`, `outreach_email_id`) plus `idx_reservations_account` for the
per-account count scans. New table → CI's schema.sql run creates it on
existing databases automatically; no workflow step needed (same as
Stage 9's audit table).

### `src/gmail-quota.ts` (new)
- **`reserveQuota` (§12.2)** — one INSERT…SELECT that lands only when
  `(sent today for this account) + (active reservations for this account)
  < daily_limit`. D1 executes single statements atomically, so there is no
  read-then-write window at any concurrency. `changes === 0` → quota error
  with the 配额 wording that batch code (Stage 10's machine and campaign
  quota-stop) already keys on. A UNIQUE violation (same email holding two
  slots) becomes a quota-style "预留冲突" error — nothing was sent, so the
  caller treats it as a retriable stop.
- **Slot lifecycle**: rows exist only while a slot is *held*. Commit
  (success) and definite rejection DELETE the row — completed sends are
  counted by `gmail_send_log`'s `sent` rows exactly as before, and deleting
  (rather than flipping a status) is what lets a legitimately retried email
  reserve again without colliding with its own UNIQUE key. The spec's
  `status` column is kept for schema parity (live rows: `'reserved'`).
- **`reapExpiredReservations` (§12.4)** — reservations past
  `expires_at` (TTL 15 min, well above a live send's token + 30s Gmail
  timeout + logging) are deleted, freeing both the slot and the key. Runs
  inside every reserve.
- **Fail-closed**: a missing reservations table (or any DB error) throws —
  a quota control must not degrade into "allow".
- **Unknown outcomes hold their slot** (Stage 10's `uncertain`): a send
  that may have reached Gmail may have consumed Gmail-side capacity, so the
  hold survives until the TTL instead of vanishing with no replacement
  count.

### `src/gmail.ts`
- `sendOutreachEmail`: the old non-binding `assertQuota` (aggregate
  read-then-hope) is replaced by the binding `reserveQuota` immediately
  **before** the Gmail fetch (after account choice and token, the tightest
  possible window); definite HTTP rejection and success both release the
  slot (success via the commit path — the `sent` log row becomes the
  quota truth). Quota errors throw out of the transport, so the Stage 10
  machine reverts the row to `draft` and campaign batches keep their
  quota-stop semantics.
- `ChosenAccount` carries the per-account `daily_limit` (pool override or
  env default) so the reservation guards the right number.
- `getQuota`: adds `reserved_today` and subtracts held slots from
  `remaining` — the panel can no longer promise capacity that in-flight
  sends already took.
- `accountRemainingQuota`: subtracts per-account reservations, so
  `chooseGmailAccount`'s "healthiest pool account" pick steers toward
  genuinely free capacity instead of a reserved-out one.

## Tests (+9 → 316 total)
`tests/gmail-quota.test.ts`:
- **§12.3 verbatim**: 100 concurrent reservations, daily limit 10 →
  **exactly 10** succeed, 90 throw 配额, table holds 10 rows, and the next
  reservation still refuses — never 11, 12 or 20;
- the guard counts `gmail_send_log` (7 sent + limit 10 → 3 slots);
- **per-account isolation** (§12.2): exhausting A leaves B reservable, and
  A's history does not leak into B's guard;
- one email can never hold two slots (UNIQUE key), and `releaseReservation`
  frees slot + key for a legitimate retry;
- **§12.4**: a stale (TTL-passed) reservation is reaped and its slot
  becomes available; fresh reservations survive the reaper;
- `getQuota` reports `reserved_today` and a `remaining` that subtracts
  holds (10 − 2 sent − 3 held = 5);
- `accountRemainingQuota`/`chooseGmailAccount` prefer the account with real
  free capacity, and the chosen account carries its `daily_limit`.

## Verification
- `npx tsc --noEmit`: pass
- `npm test`: **316/316 pass** (was 307, +9; 20 files)
- `node scripts/check-panel.mjs`: 4 panels clean
- `npx wrangler deploy --dry-run` (offline): pass

## Security Risks Fixed
- Baseline **#3 (P0)**: the quota race. Capacity is now taken by a single
  atomic statement per account; concurrent batches physically cannot
  exceed `daily_limit`, in-flight holds are visible (`reserved_today`) and
  TTL-reaped, and the quota control fails closed.

## Notes and boundaries
- Reservations are **per sender account** (spec §12.2's `gmail_account_id`);
  the aggregate total is bounded because every account enforces its own
  cap (`Σ actual ≤ Σ limits`).
- The soft pre-checks that remain (campaign loop and send-batch comparing
  `quota.sent_today + sent` against `daily_limit`) are UX shortcuts that
  stop *new* loops early; they are not load-bearing — the binding guard is
  the reservation, and the quota views it feeds now include held slots.
- Stage 10's `uncertain` holds interact conservatively by design: an
  unknown-outcome send keeps its slot for the TTL rather than freeing it
  instantly (better to under-send than to overshoot Gmail's cap).
- **Baseline #5 (campaign execution lock, Stage 12)** remains: two loops
  on the same campaign can still interleave, each email still sends at
  most once, and now the quota cannot be overshot either — but a single
  campaign-level execution lock is the next stage's scope.
