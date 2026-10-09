# Phase 9 — 联系人多触点 (contact multi-touch campaigns)

Status: shipped in full — stages 52/53/54 done (role-priority picking,
members grain rebuild + multi-contact snapshot via migration 0028,
panel wiring + persona-roles endpoint). Tests 930/930; per-stage
reports in docs/stages/stage-52/53/54.

## 0. Trigger

Phase 8 design §5 deferred three items "until an operator actually asks
for it" (docs/phase8-persona-campaigns.md §2.2 / §5). The operator has
now signed off exactly that scope:

1. Several contacts of the SAME company in one per-person campaign
   (multi-touch).
2. "Best contact" selection beyond lowest-seq — role-priority picking
   driven by operator input.
3. Per-person / contact-grain coverage views in the preview and panel.

Everything else in Phase 8 §5 stays out of scope (§6 below).

## 1. Scope summary

| Item | Mechanism | Stage |
| --- | --- | --- |
| Role-priority picking | new filter `role_priority` (ordered role keywords); per-person pick ranks email-bearing contacts by first keyword matched in `contacts.title`, then seq, id | 52 |
| Members grain-key rebuild | migration 0028: `contact_norm` STORED generated column `COALESCE(contact_id, 0)` + UNIQUE index replaces the `(campaign_id, customer_id)` PK | 53 |
| Multi-contact snapshot | new filter `contacts_per_company` (1-3, default 1); per-person snapshot takes the top-N ranked contacts per company | 53 |
| Preview slot accounting | additive `slots` / `slots_covered` counts computed from the same pick set the create snapshot uses | 53 |
| Engine pair-keying | every member UPDATE keyed `(campaign_id, customer_id, contact_id IS ?)`; `touched` set + results carry contact | 53 |
| Panel wiring + persona_role options endpoint | form inputs, member display, datalist source, endpoint regressions | 54 |

## 2. Role-priority picking (Stage 52)

New `SegmentFilters` field `rolePriority: string[]` (serialized
`role_priority`; parsed from `role_priority`/`rolePriority`):

- `sanitizeList(raw, MAX_ROLE_PRIORITY = 5, "role_priority")` — same
  trimming / dedup / 50-char cap as every other list.
- Meaningful ONLY with `perPerson` — a company-grain campaign (or saved
  group) simply ignores it. Ignore-at-use, not reject-at-parse: a saved
  group's filters JSON must keep parsing across grain flips.
- The pick's ORDER BY becomes:

  ```
  CASE WHEN ct.title LIKE ?role1 ESCAPE '\' THEN 0
       WHEN ct.title LIKE ?role2 ESCAPE '\' THEN 1
       ... ELSE <M> END, ct.seq, ct.id
  ```

  built by ONE shared builder in campaigns.ts (`contactRankSql`) used by
  BOTH the preview pick and the create snapshot — the Stage 49/51
  invariant "preview counts exactly what the generate step will adopt"
  forbids two ranking implementations. A title matching two keywords
  takes the EARLIER keyword's rank (the operator's order is the
  priority). `LIKE` is ASCII-case-insensitive (CJK roles unaffected).
  LIKE metacharacters (`%`, `_`, `\`) in keywords are escaped before
  wrapping (`%kw%`), so a literal `%` in a role cannot widen the match.
- No keywords → constant rank → `ORDER BY ct.seq, ct.id` — byte-for-byte
  Phase 8 behavior (golden tests pin this).
- This is operator-driven ordering, NOT the deferred "automatic
  persona↔contact matching" (no inference; the operator supplies the
  order, we only test membership).

## 3. Members grain-key rebuild (Stage 53, migration 0028)

`PRIMARY KEY (campaign_id, customer_id)` cannot hold multi-contact rows
(two contacts of one company collide). SQLite forbids generated columns
in a PRIMARY KEY (verified empirically on node:sqlite: "generated
columns cannot be part of the PRIMARY KEY"), so the rebuilt table has NO
explicit PK (implicit rowid) and the grain guarantee moves to:

```sql
contact_norm INTEGER NOT NULL
  GENERATED ALWAYS AS (COALESCE(contact_id, 0)) STORED,
...
CREATE UNIQUE INDEX idx_campaign_members_grain
  ON outreach_campaign_members(campaign_id, customer_id, contact_norm);
```

Verified on node:sqlite: UNIQUE over a STORED generated column holds for
BOTH grains — a second `(c, cu, NULL→0)` row and a duplicate
`(c, cu, contact)` row both violate. Writers keep writing `contact_id`
only; `contact_norm` has exactly one definition.

Migration follows the 0019 precedent exactly: single transaction (D1
runs the whole `--file` as one implicit transaction), `DROP TABLE IF
EXISTS …_new` header for idempotency, explicit INSERT SELECT column list
(never `*` — 0019's rule), drop + rename, recreate
`idx_campaign_members_queue`. schema.sql is updated to the same shape
(authority for fresh installs). No FK on this table; no orphan hazard
(0019 reasoning).

## 4. Multi-contact snapshot (Stage 53)

New `SegmentFilters` field `contactsPerCompany: number` (serialized
`contacts_per_company`):

- Integer 1-3 (`MAX_CONTACTS_PER_COMPANY = 3`); anything else is
  rejected at parse like `min_lead_score`. Default 1 = Phase 8 exactly.
- Meaningful ONLY with `perPerson`; company grain reads it as 1.
- The 3-cap is the §2.2 spam guard made concrete: "one brand mailing N
  mailboxes at the same company in one sweep looks like spam" — N ≤ 3
  and an explicit operator opt-in keeps multi-touch deliberate.
- Snapshot pick (window function, verified supported on node:sqlite):

  ```sql
  SELECT customer_id, contact_id FROM (
    SELECT c.id AS customer_id, ct.id AS contact_id,
           ROW_NUMBER() OVER (PARTITION BY c.company_id
                              ORDER BY <rank>, ct.seq, ct.id) AS rn
    FROM customers c
    JOIN contacts ct ON ct.company_id = c.company_id
    WHERE c.id IN (…chunk…) AND ct.email IS NOT NULL AND ct.email != ''
  ) WHERE rn <= ?
  ```

  chunked by the same 100-id IN batches as Phase 8. No keywords → rank
  degenerates to seq/id; `rn <= 1` reproduces the Phase 8 pick.
- Generator side needs NO change: `generateOutreachForContactIds`
  already processes arbitrary pairs with per-(brand, customer, contact)
  dedup (Stage 49 §2.3) — two contacts of one company are two
  independent pairs. That is the deferred-trigger design paying off.
- `excludeSent` at the WHERE level keeps its Phase 8 semantics
  (suppresses companies with a COMPANY-grain sent email; per-contact
  sent rows suppress only their own contact via the §2.3 dedup). Not
  "fixed" in Phase 9 — that independence is load-bearing.

## 5. Engine pair-keying + preview slots (Stage 53)

- Every member UPDATE gains `AND contact_id IS ?` (SQLite `IS` is the
  NULL-safe `=`); the pending/sendable selects already carry
  `contact_id` or will. `runCampaignGenerate`'s `touched` set re-keys
  from customer_id to the (customer, contact) pair — two same-company
  members adopt/generate independently. `CampaignStepResult.results`
  entries gain an OPTIONAL `contact_id` (additive; the panel may show
  it). `runCampaignSend`'s member updates key the same way.
  `listCampaignMembers` orders by `customer_id, contact_id` (NULLs
  first — company row, then contacts).
- Preview gains additive `slots` (member rows a create would snapshot =
  picked contacts over matched companies) and `slots_covered` (picked
  contacts that already have a draft/sent for this brand), computed
  from the SAME window-function pick set (§4) joined against
  `outreach_emails` — never a second ranking. Company grain: slots =
  matching, slots_covered = already (mirror, no behavior change).
  Existing preview fields keep their Phase 8 meanings (matching is
  companies; sample shows the top-1 pick — slots is the authoritative
  count for N > 1).

## 6. Out of scope (unchanged from Phase 8 §5)

- Automatic persona↔contact role matching (§2 is operator-supplied
  ordering, not inference).
- Sending to contact cellphone/whatsapp channels (email only).
- Cross-campaign per-person suppression lists (dedup stays per brand).
- Company-grain multi-mailbox (company grain stays one row/company).
- Automatic "best role" suggestions from the persona set (the Stage 54
  datalist offers the vocabulary; the operator orders it).

## 7. Stage plan

- **Stage 52 — role-priority picking (engine).** filters field + shared
  rank builder + preview pick + snapshot pick (still `LIMIT 1`); tests:
  parse/serialize roundtrip, rank order, LIKE escape, no-keywords golden
  (= Phase 8), preview/snapshot consistency, company grain untouched.
- **Stage 53 — grain rebuild + multi-contact.** migration 0028 +
  schema.sql; pair-keyed updates; `contacts_per_company`; window
  snapshot; preview slots; tests: rebuild preserves rows & is
  idempotent, grain index rejects duplicates both grains, multi-contact
  create (N=2/3, cap, contact dedup), per-pair adoption in generate,
  per-pair send bookkeeping, legacy campaign regression.
- **Stage 54 — panel & views.** campaign form: contacts-per-company +
  role-priority inputs (per-person section); `GET /admin/api/persona-roles`
  (distinct current `persona_role` values — closes Stage 51's deferred
  options-endpoint item; also feeds the existing persona_roles filter
  input's datalist); members view per-contact display; preview slots
  display; endpoint regressions; `node scripts/check-panel.mjs` is a
  REQUIRED gate for this stage's admin.ts changes (the Stage 41 lesson).

Gates per stage: vitest full green → tsc 0 → wrangler dry-run → stage
report (docs/stages/) → commit `phase9: stage NN - …`.
