# Stage 50 — Persona campaigns, part 2: the campaign engine

**Phase 8** · docs/phase8-persona-campaigns.md §2.1/§2.2/§2.5
Commit: `phase8: stage 50 - persona campaign engine`

## What

The campaign layer learns two new dimensions, both carried inside the
filters JSON (zero new columns, zero migration):

- **§2.1 `personaRoles`** — `SegmentFilters.personaRoles: string[]`
  (snake_case `persona_roles`, sanitizeList like the other lists: ≤10
  values, trimmed, deduped). SQL: `EXISTS (SELECT 1 FROM research_personas
  rp WHERE rp.customer_id = <outer>.company_id AND rp.is_current = 1 AND
  rp.persona_role IN (...))` — exact IN over the Stage 41 typed roles,
  superseded runs don't count, same correlation-safe aliasing rule as
  has_buying_signal. Because it lives in the SHARED builder, the 海选
  pre-filter endpoint gets it too (`persona_roles` query param → count
  and action=queue narrow by the same roles the campaign screen uses).
- **§2.2 `perPerson`** — `SegmentFilters.perPerson: boolean`
  (snake_case `per_person`, same truthy semantics as
  has_buying_signal, default false = company grain). The grain travels
  with the campaign through its filters JSON, so the panel can restore it
  and the generate step can dispatch without a second source of truth.
- **Per-person snapshot** (createCampaign): one member per matched
  company — the members PK stays (campaign_id, customer_id) — carrying
  `contact_id` = that company's pick: the lowest-seq email-bearing
  contact, ties by id
  (`ORDER BY ct.seq, ct.id LIMIT 1`, email non-null and non-empty).
  Companies without such a contact drop out; `companies` (matched
  companies) joins `total` (members) in the response + audit metadata so
  the drop-out is visible. All-ineligible segment → "没有可发送的联系人：匹配的公司都没有带邮箱的联系人" instead of an empty campaign.
  Company grain needs no company mailbox here: `requireEmail: !perPerson`.
- **§2.5 generate dispatch** (runCampaignGenerate): the pending batch now
  reads `contact_id` and splits by grain — company ids →
  `generateOutreachForCustomerIds`, (customer, contact) pairs → Stage
  49's `generateOutreachForContactIds`. Either half may be empty; its
  call is skipped. Adoption, drafts, retryable-vs-terminal classification
  (new `classifyContactGenerationError`, keyed by the PAIR) and the
  campaign error banner all work per half; member UPDATEs stay keyed by
  the PK. `CampaignDeps` gains `generateContacts` (injectable, same seam
  as `generate` — the state machine stays testable without tokens).
- **Preview is grain-aware** (previewSegment): per-person matching
  requires an email-bearing contact (the same pick), `has_draft` and
  `already` count the PICKED contact's drafts for the brand
  (`e.contact_id = <pick>`) — so the operator's preview counts exactly
  what the generate step will adopt or generate, and a company-grain
  draft never masquerades as per-person coverage (pinned both ways).
  Company grain keeps its exact pre-Stage-50 shape (contact-grain drafts
  still count toward the company, as before).
- **Members listing** (listCampaignMembers): SELECT gains
  `m.contact_id` + contact display columns (contact_ref/first/last/title/
  email via LEFT JOIN contacts) for the Stage 51 panel table.

## Files

- `src/campaigns.ts` — SegmentFilters.personaRoles/perPerson +
  EMPTY_FILTERS + parse/serialize (legacy JSON → defaults, pinned);
  persona EXISTS in buildSegmentWhere; grain-aware previewSegment;
  per-person createCampaign snapshot (chunked IN, 100); runCampaignGenerate
  dispatch + classifyContactGenerationError; CampaignDeps.generateContacts;
  listCampaignMembers contact columns.
- `src/admin.ts` — preFilterCustomers passes `persona_roles`; campaign
  create audit metadata gains companies/per_person (response is additive:
  `{ok, id, total, capped, companies}`).
- `tests/campaign-targeting.test.ts` — +16: parse/round-trip/legacy
  defaults; EXISTS SQL shape bare+aliased; sqlite correlation/no-leak/
  superseded/AND-with-signals/baseline; preview persona + per-person
  grain (matching/already/has_draft per pick, company draft does not
  leak, company grain unchanged); pre-filter endpoint persona_roles.
- `tests/campaign-steps.test.ts` — +6: snapshot pick (lowest seq, tie by
  id, no-mailbox company included, drop-outs reported via companies vs
  total, filters JSON carries per_person); all-ineligible refusal;
  dispatch routes per-person to the contact generator (company generator
  must-not-run stub); adoption takes THIS contact's draft, never the
  company mailbox's; terminal-vs-retryable pair errors; members listing
  contact columns.
- Fixture follows (schema drift, no assertion changes):
  campaign-steps/campaign-lock/request-id-trail members DDL gains
  contact_id; campaign-steps gains a contacts table.

## Semantics pinned

- Old payloads/screens: personaRoles [] + perPerson false everywhere —
  every generated SQL string for a legacy filter set is unchanged
  (baseline tests pin the unfiltered list; company grain preview pinned
  byte-for-behavior).
- excludeSent stays COMPANY-grain for per-person campaigns (conservative
  by design: a company already emailed at company grain is not re-mailed
  per-person in the same campaign's exclude pass; the pair dedup
  remains the hard guarantee).
- Same contact never gets the same brand twice (Stage 49 triple key);
  a later campaign MAY pick a different contact at the same company —
  the Stage 50 snapshot is free to choose a different pick if contacts
  change between campaigns.
- Mixed-grain batches are handled (dispatch splits any pending mix) but
  cannot arise from the panel: a campaign's grain is fixed by its
  filters JSON at creation.

## Evidence

- `vitest run` → **895 passed / 895 (68 files)**, was 871/871; +24.
- `tsc --noEmit` → 0 errors.
- `wrangler deploy --dry-run` → Total Upload 594.55 KiB / gzip 144.70
  KiB (was 584.95/143.14).

## Not done here (deliberate)

- Panel forms (per-person checkbox, persona roles input, members table
  contact column) → Stage 51.
- Several DIFFERENT contacts per company in one campaign (PK rebuild) —
  out of scope per design §2.2 amendment; the triple dedup key keeps
  the door open.
