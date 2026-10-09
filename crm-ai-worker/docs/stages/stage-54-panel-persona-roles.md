# Stage 54 — Panel wiring + persona-roles endpoint

Phase 9 (docs/phase9-contact-multi-touch.md §5/§7). Committed: `phase9: stage 54`.

## What shipped

- **GET /admin/api/persona-roles** (handleCampaignApi) — distinct
  `persona_role` values across CURRENT research runs with per-role
  distinct-customer counts, ordered count-desc then role (usefulness
  first). `persona_roles` and `role_priority` both match stored values
  exactly, so the datalist offers exactly what exists. Fail-open via
  `safeLog("warn", …)` on a migration-pending database: empty list, never
  a 500 on panel load. Dispatched alongside the campaign routes
  (Stage 51 leftover closed: the input shipped without its options
  source).
- **Campaign form** — `cgPersonaRoles` gained its `list`; new
  `cgRolePriority` input (same datalist) and `cgContactsPer` select
  (每公司 1/2/3 人). `cgFilters()` sends `role_priority` +
  `contacts_per_company`; `cgSetFilters()` restores both (a stored
  out-of-range value falls back to 1, not a broken select).
- **Preview render** — when per-person with N>1, a dedicated slot line:
  共 X 个联系人触点（每公司至多 N 个），其中 Y 个该品牌已有开发信，
  X−Y 个需要生成 — reading Stage 53's `slots`/`slots_covered`, with
  company-grain mirrors as fallback for older payloads.
- **Create success message** — "每家公司按角色优先级取至多 N 个有邮箱
  联系人", plus a batch-spacing suggestion when N>1 (spam-观感 guardrail
  is operational advice, not just a cap).
- **Hint text** — the per-person sentence now describes role-priority
  ordering and the N-contact pick instead of Phase 8's fixed one-contact
  rule.
- **Members list** — no change needed: Stage 50's per-contact column
  renders multi-touch rows naturally, and the header already counts
  contacts for per-person campaigns.
- **Init** — `loadPersonaRoleOptions()` runs on campaign-tab activation
  (fail-soft: an empty datalist leaves free-text entry, the Stage 51
  status quo).

## Tests — tests/persona-roles-endpoint.test.ts (2)

- Distinct current roles with per-role distinct-customer counts, ordered
  by usefulness; superseded (`is_current=0`), NULL and empty-string roles
  never surface.
- Fail-open: missing `research_personas` table → 200 with `{roles: []}`
  (and the warn line, visible in test stderr).

## Gates

- **check-panel: OK — 7 panels clean** (hard gate; admin.ts touched)
- vitest 930/930 (73 files; +2 new over Stage 53's 928)
- tsc --noEmit: 0
- wrangler dry-run: 605.05 KiB / gzip 147.22 KiB

## Notes

- The first full-suite run failed the repo-wide no-console guard
  (tests/safe-log.test.ts): the endpoint's fail-open log must go through
  `safeLog`, not `console.warn` — exactly the guard doing its job; fixed
  before commit.

## Phase 9 status

Stages 52 (role-priority) + 53 (grain rebuild + multi-contact) + 54
(panel + endpoint) complete. Remaining: README Phase 9 section + phase
wrap-up (Status → shipped) in the final docs pass.
