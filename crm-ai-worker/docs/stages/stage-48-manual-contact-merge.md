# Stage 48 — Contact merge, part 2: manual merge endpoint + panel

**Phase 7** · docs/phase7-contact-merge.md §4/§5
Commit: `phase7: stage 48 - manual contact merge`

## What

Give the operator a safe way to fix EXISTING duplicate contacts. Stage 47
stopped making new ones; this stage merges the rows that already exist,
one company at a time, with the server re-validating everything the panel
proposes.

- **`POST /admin/api/customers/:id/contacts/merge`** — body
  `{survivor_contact_id, merged_contact_ids}`. Validation: non-empty ids
  (≤100 chars), deduped merged list of 1–10, survivor not in the merged
  list; every id must be a contact of THIS company (a foreign id is a
  404, never a silent cross-company merge). Fill-NULL merge into the
  survivor over the 11 merge fields (CONTACT_MERGE_FIELDS — names, title,
  department, email/cellphone/tel/whatsapp/linkedin, social_accounts);
  `filled_fields` reports what actually filled. One atomic D1 batch:
  UPDATE survivor → repoint `research_facts` + `evidence` (both scoped by
  customer/company id — other companies' rows stay untouched) → DELETE
  the merged rows. Audited as CONTACT_MERGE (ids + filled_fields only, no
  raw contact data). User errors return 400/404 JSON directly — the
  customers API catch block only maps internal errors, same as
  updateCustomer.
- **Panel (renderContacts)** — each contact card gets a 疑似重复 badge
  (amber) when any normalized key (email / cellphone / whatsapp / name)
  collides with another card — pure client-side counting, a hint not a
  verdict — plus a 选择 checkbox. With ≥2 checked, 合并所选联系人
  POSTs; the lowest-seq picked row is the survivor, a confirm dialog
  spells out the fill-NULL + repoint semantics, success reloads the
  detail view.

## Files

- `src/admin.ts` — CONTACT_MERGE_FIELDS + mergeCustomerContacts (after
  preFilterCustomers), route before parseCustomerId dispatch, panel
  renderContacts/wireMergeButton upgrade (checkboxes, dup badge, merge
  button; wired in openDetail after innerHTML, the score-fill pattern).
- `tests/contact-merge.test.ts` — +4 endpoint tests through
  handleAdminRequest with Bearer auth (FakeD1 + full customers DDL):
  happy path (fill-NULL proven at SQL level on node:sqlite: title 'CEO'
  kept, NULLs filled; merged row deleted; both reference tables repointed
  within the company, other_co rows untouched; audit row with metadata),
  foreign-id 404, survivor-in-list / empty-list / empty-survivor / >10
  400s, unknown customer 404.

## Semantics pinned

- Fill-NULL is computed in JS from the loaded rows (values dict), so
  `filled_fields` is exact; the UPDATE writes all 11 fields with the
  merged values — same COALESCE-in-application semantics as Stage 47.
- Repoints are scoped: `WHERE customer_id = ?` / `WHERE company_id = ?`
  — an evidence row of another company with the same contact_id string
  is not moved (pinned by test).
- Deleting the merged rows frees their seq/contact_id; the UNIQUE
  indexes only see live rows, and audit history mentioning a deleted id
  is a record, not a reference (design §3).
- RBAC needs no change: POST under /admin/api/customers… already maps to
  customers.write (rbac.ts:188-196).
- No schema change, no migration.

## Evidence

- `vitest run` → **862 passed / 862 (68 files)**, was 858/68; +4 in
  tests/contact-merge.test.ts.
- `tsc --noEmit` → 0 errors.
- `wrangler deploy --dry-run` → Total Upload 583.92 KiB / gzip 142.91 KiB
  (was 577.04/141.25).

## Not done here (deliberate)

- Automatic backfill of old duplicates — out of scope per design §5
  (merging is an operator judgement call).
- Cross-company merge, contacts timestamps, persona campaigns → Phase 8
  candidates.
