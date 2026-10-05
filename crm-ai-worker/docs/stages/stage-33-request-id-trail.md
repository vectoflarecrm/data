# Stage 33 — Per-row request_id (post-V2)

Closes the final report's last traceability deferred item: business event
rows now carry the UUID of the admin request that produced them.

## The chain, before and after

Stage 20 gave every admin/API request one UUID — returned as the
`X-Request-ID` response header, stamped on every `audit_logs` row the
request writes, and embedded in any 500 body. But the business rows the
request produced (the draft it generated, the send attempts it made, the
import rows it inserted) did not carry it, so "这一封邮件为什么被发送"
had to walk indirect joins (email → audit metadata → request).

After this stage:

```
outreach_emails.request_id ─┐
gmail_send_log.request_id ──┼── same UUID ── audit_logs.request_id (that request's rows)
customer_imports.request_id┘                 + X-Request-ID response header
```

One hop from any row to its request, and one `WHERE request_id = ?` from a
request to every row it touched.

## Scope — what carries the id, what deliberately does not

| Table | Writer | request_id |
|---|---|---|
| `outreach_emails` (drafts) | admin POST generate (panel sweep or campaign step) | the GENERATE_EMAIL request's id |
| `gmail_send_log` (send attempts) | admin POST send-one / send-batch / campaign send | the SEND_EMAIL request's id |
| `customer_imports` | admin POST import | the IMPORT_CSV request's id (all rows of one import share it) |
| `research_runs` / `evidence` | **cron only** — no HTTP context exists | excluded: their correlation key is `research_run_id` (`evidence.research_run_id` → run); a perpetually-NULL request_id would mislead |
| `api_key_usage` | per-key daily counters | excluded: aggregate semantics, not event rows |

## Threading (additive optional params — no signature breaks)

- `gmail.ts` — `sendOutreachEmail` options gain `requestId?: string | null`;
  `logSend` binds it into the INSERT (both the `sent` and `failed` branches).
- `outreach.ts` — `generateDraftForCustomer` takes `requestId` and binds it
  into the draft INSERT; `generateOutreachEmails` /
  `generateOutreachForCustomerIds` take it as an optional trailing param.
- `campaigns.ts` — `runCampaignGenerate` / `runCampaignSend` take it after
  the deps param and forward it (generate call / transport options).
- `outreach-send.ts` — **no change**: its `options` is
  `Parameters<typeof sendOutreachEmail>[2]`, so the new field flows through
  the state machine to the transport untouched.
- `admin.ts` — the five call sites pass `getRequestId(request)`; the import
  handler reads it once and binds it on both INSERT shapes (matched +
  inserted).
- The injected seams (campaign `CampaignDeps`, the send state machine's
  `transport`) stay backward compatible: omitted id → `null` → column NULL
  (pinned by a test).

## Schema

- `schema.sql` — the three CREATE TABLEs gain `request_id TEXT`.
- `migrations/0018_business_request_ids.sql` — change record + 3 ALTERs.
- CI `deploy-worker.yml` — new "Migrate business request_id columns
  (post-V2 Stage 33)" step: per-statement ALTER with duplicate-column
  tolerance, then `pragma_table_info` verification per table (the same
  self-healing pattern as every Security V2 migration step).
- Old rows keep NULL — the column populates from the first deploy onward;
  the data-retention prunes and every reader are unaffected.

## Verification

- `tests/request-id-trail.test.ts` — 5 tests:
  - Campaign seam threading (3): the generator fake receives the id as its
    4th arg; omission → `null` (backward compat); the transport options
    carry `requestId` through `runCampaignSend`.
  - Real import path (2): `customer_imports.request_id` === the response's
    `X-Request-ID` === the `IMPORT_CSV` audit row's `request_id` (matched
    AND inserted rows both stamped — the audit ↔ business alignment IS the
    shortened chain); customer → import row → request traceability join.
- Two test schemas that run the real import path gained the column
  (`tests/audit-log.test.ts`, `tests/csv-limits.test.ts`) — the same
  schema-follows-schema.sql convention as Stage 9.
- Full suite: **679/679 (55 files)**, zero regressions; `tsc --noEmit`
  clean; dry-run 532.92 KiB (gzip 131.24 KiB); 7 panels clean.
