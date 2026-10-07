# Stage 49 — Persona campaigns, part 1: per-person generation layer

**Phase 8** · docs/phase8-persona-campaigns.md §2.3/§2.4/§3
Commit: `phase8: stage 49 - per-person outreach generation`

## What

The substrate for persona-targeted per-person campaigns: drafts can now
address a CONTACT instead of the company mailbox, and the brand dedup
key widens from (brand, customer) to (brand, customer, contact) — the
per-person dedup phase4 §4.4 armed. No campaign wiring yet (Stage 50);
the panel follows in Stage 51.

- **`outreach_emails.contact_id`** (nullable): NULL = company mailbox,
  every pre-Phase-8 row — semantics byte-identical. non-NULL = the draft
  goes to that contact's own address.
- **Dedup independence, both directions pinned by tests**: the three
  company-grain lookups (the brand keyword sweep's NOT IN,
  `generateOutreachForCustomerIds`'s existing-drafts query, the shared
  segment builder's `excludeSent`) now filter `contact_id IS NULL`; the
  per-person lookup matches `contact_id` exactly. A per-person draft
  never suppresses a company draft and vice versa — a LATER campaign can
  target a different contact at the same company while the same contact
  never gets the same brand twice.
- **`generateOutreachForContactIds`** (outreach.ts): same contract shape
  as `generateOutreachForCustomerIds` (already/drafts/errors) so the
  Stage 50 generate loop can consume either. Terminal per-pair errors
  (the operator asked for that PERSON, so failures must be visible):
  missing/foreign rows → "客户或联系人记录可能已被删除" (contacts hang
  off customers.company_id, the TEXT key), no email → "该联系人没有邮箱".
- **Prompt**: `buildOutreachPrompt` gains an optional `recipient` —
  overrides the company-level first_name/last_name/title/email, and adds
  an explicit "本封邮件的收件人" section ("不是泛泛的公司邮箱"); the
  existing rule 539 (angle per recipient role against the persona
  section) then does the persona work. No recipient → byte-stable
  legacy shape (pinned).
- **Stage 13 rule unchanged**: email_to is always an address from our
  database (company row or contact row), never from model output.

## Files

- `schema.sql` — outreach_emails.contact_id + members.contact_id (both
  commented, NULL = company grain) + idx_outreach_contact for the dedup
  lookups.
- `migrations/0027_campaign_contact_grain.sql` — change record (additive
  ALTERs land via the operator's idempotent deploy block, Stage 17+
  precedent).
- `src/outreach.ts` — OutreachRecipient + recipient on
  buildOutreachPrompt/generateDraftForCustomer (INSERT records
  contact_id and the contact's address), `contact_id IS NULL` on the two
  company-grain queries, new generateOutreachForContactIds.
- `src/campaigns.ts` — excludeSent subquery gains `contact_id IS NULL`
  (one line; the personaRoles filter itself is Stage 50).
- `tests/outreach-personas.test.ts` — +9 (recipient prompt override ×2;
  per-person dedup adoption; independence forward/backward; sweep keeps
  a per-person-only customer; no-email terminal; foreign/missing rows
  terminal; empty input + pair dedup).
- `tests/campaign-steps.test.ts` / `tests/campaigns.test.ts` — bare
  fixtures gain the contact_id column (schema follow, no assertion
  changes; one positional INSERT made column-named).

## Semantics pinned

- The success INSERT (real AI call) is not automated — no fake provider
  keys, a real call is never spent. Every other path is covered via the
  no-key env (callAiForOutreach returns null → "AI returned empty"
  marks the taken path without writing rows).
- Existing campaigns/rows: contact_id NULL everywhere, all three
  company-grain queries behave identically to before (IS NULL is a
  no-op on NULL-only tables).
- No PK/index change on members (design §2.2: one member row per
  company; per-person snapshot = one email-bearing contact, Stage 50).

## Evidence

- `vitest run` → **871 passed / 871 (68 files)**, was 862/68; +9.
- `tsc --noEmit` → 0 errors.
- `wrangler deploy --dry-run` → Total Upload 584.95 KiB / gzip 143.14
  KiB (was 583.92/142.91).

## Not done here (deliberate)

- Campaign wiring: personaRoles filter, per-person snapshot, generate
  loop dispatch → Stage 50.
- Panel forms/member display → Stage 51.
