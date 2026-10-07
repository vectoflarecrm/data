# Phase 7 — Contact merge: design

Status: design committed — stages 47/48 pending.

Source requirements: phase4 §4.4's deferred item ("contact MERGE (same
person, new channel → one row) needs dedup keys, merge semantics and a
panel UI"), the phase4 gap table ("the same person with a newly found
email becomes a second row"), and the standing 建议 §十八 data-quality
goal. Operator picked it as Phase 7 (2026-10-07).

## 1. What exists (HEAD 11cef41)

- `contacts` (schema.sql:719): `contact_id` (`<display_id>_<seq pad3>`,
  UNIQUE), `company_id`, `seq` (UNIQUE per company), name/title/department/
  email/cellphone/tel/whatsapp/linkedin_url/social_accounts. No timestamps,
  no run attribution, no soft delete.
- Write path (index.ts Step 5, ~2345): exact fingerprint
  (`first|last|email|cell|whatsapp` lowercased) skip vs. DB + within batch,
  `INSERT OR IGNORE`, `seq = MAX(seq)+1`. **Gap**: same person + a new
  channel (new email) passes the fingerprint and lands as a second row.
- References to `contact_id`: `research_facts.contact_id` (Stage 42
  linkage, actively written, value-matched email/phone) and
  `evidence.contact_id` (legacy V1 column — the Stage 14+ writer does not
  populate it; kept for historical rows).
- NOT referencing contacts: `outreach_emails` (company-grain, sends to
  `email_to`/customers cache columns), personas, campaigns.
- Panel: detail modal `renderContacts` (read-only cards, admin.ts:3668);
  `getCustomerContacts` (admin.ts:873).
- RBAC: any POST under `/admin/api/customers…` already maps to
  `customers.write` (rbac.ts:188-196) — a merge route needs no rbac change.
- No test drives processCustomer end-to-end (the contact persist path has
  no direct coverage — the planner gets its own unit tests instead).

## 2. Same-person rule (dedup keys, deliberately conservative)

Two contact records are the SAME PERSON when:

1. a **channel identity** matches — normalized email, cellphone or
   whatsapp (trim + lowercase; phones also strip separators, the same
   nested-REPLACE semantics the Stage 42 linkage uses), AND
2. the **names are compatible** — normalized name equal, or at least one
   side has no name.

Name-only matches do NOT merge automatically (two different people can
share a name at one company); channel matches with CONFLICTING names do
NOT merge automatically (a shared `info@` mailbox can front two people).
Both residual cases stay visible as 疑似重复 and are mergeable by hand.

## 3. Merge semantics

- **Fill-NULL-only.** The survivor keeps its `contact_id`, `seq` and every
  non-null field; NULL fields fill from the merged rows in the order
  given. Nothing is ever overwritten.
- Write-time (Stage 47) the fill is a single
  `SET field = COALESCE(field, ?)` UPDATE per merge target — SQL itself
  enforces "never overwrite non-null".
- **Repoint, then delete.** `research_facts.contact_id` and
  `evidence.contact_id` rows pointing at merged ids are repointed to the
  survivor (scoped: same company), then the merged rows are deleted — in
  ONE D1 batch (atomic: no window with dangling references).
- Deleting frees a `seq`/`contact_id`; the next insert takes
  `MAX(seq)+1`, and the freed id no longer exists, so the UNIQUE indexes
  stay satisfied. Historical audit metadata keeps mentioning old ids by
  design (an audit trail is a record, not a reference).
- No schema change, no migration, no CI step.

## 4. Surfaces

### Stage 47 — write-time merge (stop making new duplicates)

- New leaf module `src/contact-merge.ts`: normalization helpers +
  a PURE planner. Input: the company's existing contact rows + this run's
  `found_contacts`; output: per-contact decision —
  skip (exact fingerprint, unchanged semantics) / merge-into (channel +
  name-compat; carries which fields to offer) / insert (provisional
  seq/contact_id) — plus the final statement list (UPDATE … COALESCE /
  INSERT … VALUES) as `{sql, binds}` pairs so index.ts only maps them to
  `env.DB.prepare` and tests can run the real SQL on node:sqlite.
- In-batch folding: a merge into a row inserted earlier in the same run
  folds into that INSERT's values; merges into existing rows are UPDATEs
  (batch statements run sequentially, so a second UPDATE sees the first
  one's COALESCE result); the planner keeps its in-memory view current so
  later contacts match against enriched rows.
- index.ts Step 5: load full existing rows (all merge-relevant columns),
  call the planner, execute the batch. One AI call, one contact batch —
  the pipeline's shape is unchanged.

### Stage 48 — manual merge (fix existing duplicates)

- `POST /admin/api/customers/:id/contacts/merge`
  `{survivor_contact_id, merged_contact_ids: [...]}`:
  validate (non-empty strings, 1–10 merged, survivor ∉ merged, no dups),
  resolve customer → company, require every id in the company's contact
  list (cross-company ids → 400), fill-NULL merge + repoint + delete in
  one batch, audit `CONTACT_MERGE` (metadata: ids + which fields filled —
  no raw contact data), respond `{merged: n}`.
- Panel: each contact card gains a checkbox; a 合并所选 button merges the
  selection with the **lowest-seq selected row as survivor** (oldest row =
  stable identity, deterministic and stated in the confirm dialog). Cards
  whose normalized email/cellphone/whatsapp/name collides with another
  card get a 疑似重复 badge (pure client-side computation, no server
  change). On success the detail view reloads.
- Tests: endpoint via `handleAdminRequest` + FakeD1 (happy path with
  research_facts/evidence repoint assertions, cross-company rejection,
  fill-NULL-not-overwrite, audit row present, merged rows gone).

## 5. Out of scope

- Cross-company merge (a person moving companies) — different problem,
  needs its own design.
- Automatic backfill of existing duplicates — merging is an operator
  judgement call (the conservative rule is about not creating NEW dups;
  existing rows merge by hand).
- `contacts` run attribution / timestamps (phase4 gap table) — no consumer
  yet.
- Persona-per-person campaigns (the original §4.4 trigger) — Phase 8
  candidate.
