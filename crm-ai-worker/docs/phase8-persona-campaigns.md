# Phase 8 — Persona-targeted per-person campaigns: design

Status: shipped in full — stages 49/50/51 done (per-person generation layer + persona campaign engine + panel wiring; per-person dedup triple key live).

Source requirements: phase4 §4.4's trigger ("revisit when a persona-targeted
campaign needs per-person dedup counts"), phase6 §3.6 out-of-scope
("persona-targeted per-person campaigns"), phase7 §6 ("Persona-per-person
campaigns (the original §4.4 trigger) — Phase 8 candidate"). The whole
Phase 4→7 arc built towards this: typed personas (Stage 41), fact→contact
linkage (Stage 42), persona-aware prompt (Stage 41), clean contact rows
(Stage 47/48 merge).

## 1. Problem

Campaigns today are COMPANY-grain: one member row per customer, one draft
per (brand, customer), sent to `customers.email`. The persona-aware prompt
already angles per recipient role, but the recipient is the company
mailbox. Two gaps:

1. **Targeting** — no way to filter companies by buyer-persona role
   ("give me every company whose current research found a Purchasing
   Manager").
2. **Per-person sending** — no way to send one email per CONTACT (each
   with a role-matched angle), and the (brand, customer) dedup key would
   actively block the second person at the same company.

## 2. Design

### 2.1 Targeting filter: `personaRoles` (company grain, shared builder)

`SegmentFilters` gains `personaRoles: string[]` (default `[]`, off). SQL =
correlated-safe EXISTS (Phase 6 pattern, bare/alias table handling):

```sql
EXISTS (SELECT 1 FROM research_personas rp
        WHERE rp.customer_id = <t>company_id AND rp.is_current = 1
          AND rp.persona_role IN (?, ...))
```

Exact-match IN over the typed `persona_role` values (free text, but typed
by one writer; LIKE would over-match). `sanitizeList` semantics (≤10
values, 50 chars each, dedup, error 中文). Because the pre-filter and
campaign paths share `buildSegmentWhere`, both get the filter; old stored
filters JSON deserializes with the new default — byte-identical behavior
for existing payloads.

### 2.2 Per-person campaign grain

`outreach_campaign_members` gains `contact_id INTEGER NULL` — NULL means
company grain (every existing row; existing campaigns untouched),
non-NULL means "this member sends to that contact". The table's PK
`(campaign_id, customer_id)` pins the grain: **one member row per
company either way**, so a per-person snapshot takes exactly ONE
email-bearing contact per matched company (lowest seq — the first
contact the research found; a company with no email-bearing contact
contributes no member, and the create response reports the count). No
new unique index needed — the PK already guarantees it.

"Send to SEVERAL contacts of the same company in one campaign" is
deliberately out of scope: it would require rebuilding the members PK
(the 0019 FK-rebuild precedent exists, but the business case is thin —
one brand mailing two mailboxes at the same company in one sweep looks
like spam, not personalization). Deferred with a trigger: an operator
actually asking for it. The (brand, customer, contact) dedup (§2.3) is
what keeps the door open — a LATER campaign can target a different
contact at the same company, while the same contact never gets the same
brand twice. That is the per-person dedup phase4 §4.4 armed, and it is
exactly what Phase 7's merged contact rows make reliable.

### 2.3 Email grain: `outreach_emails.contact_id`

`outreach_emails` gains `contact_id INTEGER NULL`. NULL = company mailbox
(all existing rows — semantics unchanged). The brand dedup key becomes
the triple (brand, customer_id, contact_id):

- company-grain lookups (`generateOutreachForCustomerIds`, campaign
  `excludeSent`) add `AND contact_id IS NULL` — a per-person draft no
  longer suppresses the company draft, and vice versa;
- per-person lookups match `AND contact_id = ?` per pair.

`email_to` still comes from the database row (contact.email), never from
model output (Stage 13 rule unchanged). The send path
(`runCampaignSend`/state machine) needs no change — it sends
`outreach_emails.email_to`, which is the contact's address for per-person
drafts.

### 2.4 Generation: `generateOutreachForContactIds` (outreach.ts)

New sibling of `generateOutreachForCustomerIds`, same outcome shape
(already/drafts/errors) so `runCampaignGenerate` consumes either
uniformly. Per pair: load contact (no email → terminal error "该联系人
没有邮箱"), load customer, personas as today. Prompt: new optional
`recipient` on `buildOutreachPrompt` overrides the company-level
first_name/last_name/title/email with the contact's, and adds one line
making the single recipient explicit ("本封邮件的收件人:<name>—<title>");
the existing rule 539 ("优先按收件人职位匹配对应画像") then does the
persona angle work. Draft INSERT records contact_id + contact email. 2s
inter-call delay, one AI call per draft, key rotation — all unchanged.

### 2.5 Campaign engine (campaigns.ts)

- `createCampaign` gains `perPerson` (default false). per-person snapshot
  loads email-bearing contacts per matched company (one query: contacts
  JOIN the matched id list), member INSERT gains contact_id.
- `runCampaignGenerate` splits the pending batch by `contact_id IS NULL`
  vs not, calls the matching generator, unifies the outcome handling
  (already/drafts/unattributed logic identical). One campaign is always
  single-grain (per-person is fixed at creation), but the split keeps the
  loop total over both shapes.
- member list/detail queries carry contact_id + contact name for display.
- Send step unchanged (§2.3).

### 2.6 Panel (admin.ts)

- Campaign form: 按联系人发送 checkbox + personaRoles input (comma list);
  per-person create response surfaces "N 家公司 / M 个联系人".
- Campaign detail member table: contact column (name + contact_id) when
  the campaign is per-person.
- Pre-filter form gains the same personaRoles input (shared builder, so
  counts/preview work; the sweep stays company-grain).

## 3. Migration (additive only)

- `schema.sql`: the two nullable columns inside the CREATEs +
  `idx_outreach_contact (brand_name, customer_id, contact_id)` for the
  dedup lookups. No members index/PK change (§2.2).
- `migrations/0027_campaign_contact_grain.sql`: change record; existing
  databases get the columns/indexes via the operator's idempotent ALTER
  block (Stage 17+ precedent — nullable columns, no rebuild).

## 4. Staged plan

- **Stage 49 — per-person generation layer.** Schema columns + migration
  record; `recipient` on buildOutreachPrompt;
  `generateOutreachForContactIds` + triple-grain dedup in the existing
  company paths (`contact_id IS NULL`); tests (prompt override, dedup
  independence both ways, no-email contact terminal, INSERT shape).
- **Stage 50 — campaign engine.** personaRoles filter (parse/serialize/
  sanitize/SQL); per-person createCampaign snapshot; generate-loop split;
  member queries carry contact; endpoint tests + filter SQL tests.
- **Stage 51 — panel wiring.** Forms + member display + pre-filter input;
  endpoint regression for the new params; docs.

## 5. Out of scope

- Several contacts of the SAME company in one campaign (needs a members
  PK rebuild — §2.2's deferred trigger; the triple-grain dedup already
  supports a later campaign choosing a different contact).
- Automatic persona↔contact role matching beyond the AI's prompt-level
  matching (no new heuristic machinery — the prompt rule suffices).
- "Best contact" selection beyond lowest-seq (e.g. role-priority
  picking) — an input UI question, deferred with the first operator
  feedback.
- Per-person excludeSent browsing UI, contact-grain quota views.
- Sending to contact cellphone/whatsapp channels (email only).
- Cross-campaign per-person suppression lists (the triple-grain dedup is
  per brand, matching company-grain semantics).
