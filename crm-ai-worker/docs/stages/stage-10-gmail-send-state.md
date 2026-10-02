# Stage 10 Report — Gmail Sending State Machine

Branch: `feature/security-v2` · Follows: Stage 9 (audit log)

## Goal (spec §11)
The send path went straight from "row is draft" to the Gmail API and only
touched the DB afterwards — exactly the §11.2 forbidden shape. Two workers
(or two impatient clicks) could both see a draft and double-send it, and a
crash between Gmail's acceptance and the DB write left the row looking
unsent, so the next attempt would email the customer twice. Stage 10 gives
every send a durable state trail, atomic claims, idempotency keys, and
conservative crash recovery.

## Changes

### `migrations/0009_outreach_send_state.sql` (new) + `schema.sql`
`outreach_emails` gains: `idempotency_key`, `send_attempts`, `locked_at`,
`locked_by`, `last_error`, `gmail_message_id` (`status`/`sent_at` already
existed). Indexes:
- **unique partial** `idx_outreach_idempotency` on `idempotency_key`
  (spec §11.3's `CREATE UNIQUE INDEX`; partial so legacy NULL rows coexist);
- `idx_outreach_send_lock (status, locked_at)` for the stale-lock reap scan.
The same columns joined `schema.sql`'s CREATE TABLE (fresh installs), and
the deploy workflow gained a per-statement ALTER step with
duplicate-column tolerance plus a pragma verify (`n = 6`), mirroring the
Stage 4 pattern — a missing column fails the deploy instead of silently
disabling the machine.

### `src/outreach-send.ts` (new)
- **States** (spec §11.1): `draft → reserved → sending → sent`, with
  `failed` (definite rejection), `uncertain` (delivery unknown) and
  `cancelled` (reserved for future use) as terminal/held states.
- **Atomic claim**: one conditional UPDATE
  (`SET status='reserved', … WHERE id = ? AND status IN ('draft','failed')`)
  — D1 runs single statements atomically, so exactly one contender wins;
  losers get an honest classification (`already_sent` / `skipped_locked` /
  `uncertain` / refused).
- **§11.3 idempotency key**: stable SHA-256 over
  `campaign:{campaign_id}|customer:{customer_id}|v:{content-hash}` — the
  content digest stands in for the message version, so retrying the same
  row yields the same key while an edited draft counts as a new version.
  A claim whose key collides with another row's (same campaign + customer +
  content) is refused as `duplicate` by the unique index instead of
  double-sending. `campaign_id` is resolved through
  `outreach_campaign_members` (the emails table has no campaign column).
- **Stale-lock reap** (before every claim): `reserved` older than a 10 min
  TTL → back to `draft` (the Gmail call never started, nothing was sent);
  `sending` older than TTL → `uncertain` with a human-facing explanation.
  Migration-pending databases (no state columns) are a silent no-op;
  anything else logs `[outreach-send] reap failed`.
- **Outcome mapping**: transport `ok` → `sent` (also stores
  `gmail_message_id`); transport `ok:false` → `failed` + `last_error`
  (§11.1's failure branch); thrown `GmailTransportError` or any unclassified
  error → `uncertain` (§11.1's network-unknown branch — **never** auto
  retried); quota errors revert the row to `draft` and rethrow so campaign
  batches keep their quota-stop semantics (members stay `generated` for
  tomorrow).

### `src/gmail.ts` (surgical)
- `GmailTransportError` (new, exported): network-level failure or an
  unreadable 2xx body — the "delivery unknown" signal the machine maps to
  `uncertain`. Pre-send failures (config, quota, token) keep their existing
  shapes (config/token already returned `ok:false`, quota throws as before).
- The Gmail send `fetch` now carries `AbortSignal.timeout(30s)`
  (`GMAIL_SEND_TIMEOUT_MS` override, 5s floor) so a hung connection becomes
  a typed uncertain instead of blocking until the platform kills the worker.
- `resp.json()` on a 2xx is wrapped: a garbled success response is
  `GmailTransportError`, not a crash that hides a delivered mail.

### `src/campaigns.ts`
`DEFAULT_DEPS.send` now routes through `sendWithStateMachine`; the injected
seam is untouched, so the existing campaign-step tests (raw fake senders)
keep working unchanged. Duplicate campaign executions therefore send each
email exactly once (member `generated` + email `draft` gates compose with
the machine's claim).

### `src/admin.ts`
- `POST /admin/api/outreach/send-batch`: sends through the state machine;
  the picker now includes `failed` rows (explicit retry semantics — the
  machine guarantees a claimed row cannot be double-sent) and deliberately
  excludes `reserved`/`sending`/`uncertain`. Per-row results carry the
  machine `outcome`.
- `POST /admin/api/outreach/emails/:id/send`: same machine; the gate now
  allows `draft` **and** `failed`, answers **409** for in-flight
  (`reserved`/`sending`) and `uncertain` rows with honest messages, and 400
  for other statuses. The audit row records the machine outcome.
- One query fix surfaced by the new fixture: the batch picker's WHERE now
  qualifies `e.status` (previously a bare `status` that SQLite may resolve
  ambiguously against joined tables that also have a `status` column).

## Tests (+20 → 307 total)
`tests/outreach-send.test.ts` — the §11.4 list, verbatim:
- **normal send / Gmail success**: full trail (`sent`, `sent_at`,
  `gmail_message_id`, `send_attempts=1`, locks cleared, `im-…` key);
- **Gmail failure** → `failed` + `last_error`;
- **Gmail timeout** (`GmailTransportError`) → `uncertain`;
- **Worker timeout** (unclassified mid-send error) → `uncertain`;
- **quota abort** → row back to `draft`, error rethrown for batch stop;
- **duplicate request** → `already_sent`, transport called once;
- **already sent** → never reaches the transport;
- **retry** → `failed` row re-claims and sends (attempts 2, same key);
- **uncertain send** → blocked from automatic resend;
- **duplicate logical message** (two rows, same customer + content) →
  second claim refused by the unique index, row untouched;
- **the critical §11.4 case**: Gmail accepted, worker died before the DB
  write → row `sending` with a stale lock → reaped to `uncertain` → the
  next task refuses to send (transport never called), and keeps refusing;
- fresh-lock `sending` → concurrent attempt `skipped_locked`;
- stale `reserved` → back to `draft` and sendable;
- **reap phase split**: reserved→draft, sending→uncertain, fresh locks
  untouched;
- **concurrent claims**: exactly one of two interleaved attempts sends;
- **duplicate campaign execution**: `runCampaignSend` twice with the
  machine-wrapped transport → every email sent exactly once;
- **quota stop through the machine**: `quotaStop=true`, members stay
  `generated`, emails stay `draft`;
- **admin endpoints**: single send without Gmail config ends honestly
  `failed` (previously silently `draft`); 409 for in-flight/uncertain rows;
  send-batch retries `draft`+`failed` but never picks
  `reserved`/`sending`/`uncertain`.

## Verification
- `npx tsc --noEmit`: pass
- `npm test`: **307/307 pass** (was 287, +20; 19 files)
- `node scripts/check-panel.mjs`: 4 panels clean
- `npx wrangler deploy --dry-run` (offline): pass

## Security Risks Fixed
- Baseline **#4 (P0)**: crash-after-accept can no longer masquerade as
  "unsent" — the row is `sending` (fresh → skipped, stale → `uncertain`
  which never auto-resends), and concurrent claims are decided by an atomic
  conditional UPDATE, not by a read-then-write race.

## Explicitly NOT claimed here (stays for the next stages)
- **Baseline #3 (quota atomicity, Stage 11)**: `assertQuota` is still
  count-based (`sent_today < limit`), so 100 simultaneous *batches* can
  still overshoot the daily cap. The per-row state machine bounds the blast
  radius (each email sends at most once) but does not reserve quota
  atomically — that is §12/Stage 11's `gmail_send_reservations`.
- **Baseline #5 (campaign-level lock, Stage 12)**: two clicks on "send
  batch" for the *same campaign* still start two loops; each email is
  claimed exactly once, so no double-send, but the two loops share quota
  and interleave — the campaign execution lock is Stage 12's scope.
- `cancelled` has no transition yet (no endpoint asks for it); it exists in
  the enum so later stages don't need a migration to add it.
- Manual resolution path for `uncertain`: the panel's existing PATCH
  (`status: "draft"`) remains the operator's explicit override — the state
  machine refuses automation but not humans.
