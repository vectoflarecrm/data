# Stage 51 — Persona campaigns, part 3: panel wiring

**Phase 8** · docs/phase8-persona-campaigns.md §2.6
Commit: `phase8: stage 51 - persona campaign panel`

## What

The operator-facing surface for per-person persona campaigns, per design
§2.6 (three items, no more):

- **Campaign form** (定向群发): a 「按联系人发送」 checkbox
  (`cgPerPerson`) + a free-text 人物角色 input (`cgPersonaRoles`, comma
  list — typed roles from the Stage 41 persona research, exact match).
  Both ride inside the existing filters object (`cgFilters()`/restore in
  `cgSetFilters()`), so saved 客群 groups round-trip them like every
  other dimension and the create/preview endpoints need zero new params.
- **Preview wording**: with 按联系人发送 checked, the count line says
  the matching is at contact grain (只计有带邮箱联系人的公司) and the
  already-covered line refers to the TARGET CONTACT's drafts — matching
  what Stage 50's preview actually counts.
- **Create response**: per-person creation reports 「匹配 N 家公司，
  定向 M 个联系人（K 家公司没有带邮箱的联系人，已跳过）」 using the
  new `companies` field; the legacy message is unchanged.
- **Members table** (cgShowMembers): when the campaign's filters JSON
  says `per_person`, a 联系人 column appears (name + title + email +
  contact_ref) between 公司 and 国家, and the header count says 个联系人
  instead of 家. The grain is read from `campaign.filters` (progressFor
  spreads the row), so no new endpoint field was needed.
- **海选 form**: the same 人物角色 input (`pfPersonaRoles`) feeds the
  `persona_roles` query param — count and 重新入队 narrow by the same
  roles the campaign screen uses (shared builder, Stage 50 §2.1).
- The campaign form's hint paragraph explains the per-person semantics
  (earliest email-bearing contact per company; company mailbox not
  required).

## Files

- `src/admin.ts` — form controls (campaign + 海选), cgFilters/cgSetFilters
  carry per_person/persona_roles, preview/create messages, members table
  contact column, pfParams persona_roles.
- `tests/campaign-persona.test.ts` — NEW, 4 endpoint regressions: create
  per-person (companies vs total, member contact_id, filters JSON, audit
  metadata per_person/companies); legacy create byte-compatible
  (contact_id NULL, defaults); members endpoint exposes contact columns
  + filters JSON for the panel's grain detection; segment-preview counts
  matching at the contact gate and already at contact grain (company
  draft ≠ per-person coverage).
- `docs/phase8-persona-campaigns.md` — Status → shipped in full.

## Semantics pinned

- Legacy screens/payloads: cgPerPerson defaults unchecked,
  cgPersonaRoles defaults empty — the generated filters objects are
  shape-identical to Phase 6 for untouched usage (endpoint test pins the
  legacy create).
- Panel grain detection is derived (filters JSON), not a second flag —
  one source of truth.
- No new CSS: every class used already exists in the panel
  (`s-chiprow`, `s-p8-bd1 ol cbd5e1-br6-*`, `cp-hint`, `cp-table`).

## Evidence

- `vitest run` → **899 passed / 899 (69 files)**, was 895/895(68); +4.
- `tsc --noEmit` → 0 errors.
- `wrangler deploy --dry-run` → Total Upload 597.61 KiB / gzip 145.53
  KiB (was 594.55/144.70).

## Not done here (deliberate)

- Persona role picker backed by distinct research_personas values (free
  text first; needs an options endpoint + usage feedback).
- Per-person grain badge on the campaign card (the members table shows
  the grain where it matters).
- Out of scope per design §5: several contacts per company in one
  campaign, role-priority contact picking, contact-grain quota views.
