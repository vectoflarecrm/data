# Stage 53 — Members grain rebuild + multi-contact

Phase 9 (docs/phase9-contact-multi-touch.md §3-§5). Committed: `phase9: stage 53`.

## What shipped

- **migrations/0028_campaign_members_grain.sql** — single-transaction table
  rebuild (0019 precedent): the Phase 8 `PRIMARY KEY (campaign_id,
  customer_id)` hard-coded "one member per company", which is what forced
  per-person campaigns to pick exactly one contact. The rebuilt table has
  no explicit PK (platform limit, below) and enforces one row per grain
  via a UNIQUE index over `contact_norm`, a STORED generated column
  `COALESCE(contact_id, 0)`. Idempotent (leading `DROP IF EXISTS`,
  explicit-column INSERT SELECT, `IF NOT EXISTS` indexes); this table has
  no FK and no AUTOINCREMENT, so 0019's orphan defenses do not apply.
- **schema.sql** — members rebuilt to the new shape for fresh installs
  (contact_norm + grain UNIQUE index, comments explaining why no PK).
- **`SegmentFilters.contactsPerCompany: number`** — `contacts_per_company`/
  `contactsPerCompany`, integer 1-3 (server cap `MAX_CONTACTS_PER_COMPANY
  = 3`), default 1 = Phase 8 behavior. Booleans rejected outright
  (`Number(true) === 1` would otherwise slip through). Ignore-at-use with
  company grain, like rolePriority.
- **createCampaign** — per-person snapshot is now a window-function top-N:
  `ROW_NUMBER() OVER (PARTITION BY c.company_id ORDER BY ${rank} ct.seq,
  ct.id) … WHERE rn <= ?`. Same rank prefix as Stage 52 (one ranking, one
  order). Bind order textual: rank ?s (SELECT-list window ORDER BY) →
  IN-chunk ids → N. `createCampaign` itself clamps N to 1-3 so a
  hand-edited stored filters JSON cannot exceed the cap.
- **runCampaignGenerate / runCampaignSend** — every member write is keyed
  by the full grain pair: `WHERE … AND contact_id IS ?` (SQLite's
  NULL-safe equality: a NULL bind matches exactly the company row). The
  touched set is a `Set<string>` of pair keys, so one contact's outcome
  never marks, unmarks or fails its sibling. Send queue and pending order
  gained `contact_id` (deterministic sibling order); send results and
  generate results carry `contact_id` per entry
  (`CampaignStepResult.results`).
- **listCampaignMembers** — `ORDER BY m.customer_id, m.contact_id`.
- **previewSegment** — new additive `slots` / `slots_covered`: per-person
  counts the SAME window pick-set the snapshot takes (INNER JOIN on
  contacts implies the email-bearing gate); covered = picked contacts with
  a draft/sent email for the brand, joined per contact. Company grain
  mirrors the company numbers (slots = matching, slots_covered = already).

## Verified facts recorded

- node:sqlite probe (Stage 53 Inspect): generated columns CANNOT be part
  of a PRIMARY KEY; a UNIQUE index over a STORED generated column DOES
  hold for both grains (NULL company rows collapse to 0, contact rows keep
  their id) and rejects duplicates on both; window functions work in D1
  and node:sqlite alike.
- SQLite treats NULLs as distinct inside PK/UNIQUE keys, so a bare
  `contact_id` column in a unique key would NOT have protected the company
  grain — hence the COALESCE column.
- Bind order remains strictly textual: window ORDER BY rank ?s bind before
  the inner WHERE chunk ids, which bind before the outer `rn <= ?`.

## Schema compatibility

- Engine code never references `contact_norm` (writers touch `contact_id`
  only), so the Phase 8 fixtures with the OLD members PK keep passing —
  the engine does not require 0028 to be applied to run.
- tests/outreach-send.test.ts's fixture modeled the pre-Phase-8 members
  shape (no `contact_id` column at all); Stage 53's pair-keyed send needs
  that column (production has carried it since the Phase 8 migration), so
  the fixture gained `contact_id INTEGER` — schema alignment only, every
  assertion unchanged.

## Tests — +18 (2 files)

- **tests/members-grain-rebuild.test.ts (3)** — executes the real 0028
  file against a Phase-8-shape DB: rows/statuses/errors preserved with
  contact_norm computed; queue index back + status CHECK survived + no
  explicit PK + no leftover temp table; grain UNIQUE rejects a second
  company row AND a repeated contact row while a sibling contact inserts
  cleanly (the unlock); cross-campaign coexistence; re-execution tolerant
  and still enforcing.
- **tests/campaign-multi-touch.test.ts (15)** — parse (snake/camel,
  numeric strings, default 1, legacy payload, booleans/floats/out-of-range
  rejected with the actionable message); snapshot top-N by rank (N=2 with
  role keywords; N=3 caps at existing email-bearing contacts; default 1 =
  Phase 8; hand-edited 99 clamps to 3); generate per-pair independence
  (all-pairs drafting keys results by pair; a terminal failure on one
  contact leaves the sibling generated — the exact bug the old
  `WHERE campaign_id + customer_id` update had; a retryable failure leaves
  only that pair pending); send per-pair (a failed send marks only that
  contact's row, the already-sent sibling stays 'sent'; a quota stop
  between siblings leaves the un-sent one 'generated' with its draft
  intact); preview slots (pick-set count, per-contact covered with
  out-of-window drafts not counting, company-grain mirror); members
  listing sibling order.

## Gates

- vitest 928/928 (72 files; +18 new over the 910 baseline)
- tsc --noEmit: 0
- wrangler dry-run: 601.73 KiB / gzip 146.40 KiB
- No panel/admin.ts change this stage (check-panel not required; Stage 54
  will run it as a hard gate).

## Deferred to Stage 54

- Panel wiring: contacts-per-company + role-priority inputs, per-contact
  member display, slots display in the preview.
- `GET /admin/api/persona-roles` options endpoint (distinct current
  persona_role values for the datalist; Stage 51 leftover).
- check-panel + endpoint regression as the stage gates.
