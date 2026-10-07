# Stage 46 — Campaign targeting: panel wiring + endpoint proof

**Phase 6** · docs/phase6-campaign-targeting.md §4/§5 · 建议 §十八/§二十一
Commit: `phase6: stage 46 - panel targeting controls`

## What

The operator-facing surfaces for the Stage 45 engine — reusing existing
form idioms (checkbox like 有邮箱, select like 最低分), no new CSS:

1. **海选 pre-filter form** — new `有购买信号` checkbox (`pfHasSignal`)
   next to `有邮箱`; `pfParams` sends `has_buying_signal=1` when checked.
   Applies to both 统计匹配 (count) and 匹配项重新入队 (action=queue,
   i.e. re-research only companies whose current run showed signals).
2. **Campaign form (定向群发)** — new `ICP 匹配` select (`cgIcpFloor`:
   不限 / ≥25 / ≥30, mapping to `dimension_floors.icp_fit`) and `有购买信号`
   checkbox (`cgHasSignal`) between 最低分 and 排除本品牌已发送.
   - `cgFilters()` emits `has_buying_signal` + `dimension_floors`
     (`{}` when the select is 不限) — preview / create / save-group all
     flow through it, so the new dimensions ride along with zero extra
     endpoint wiring.
   - `cgSetFilters()` restores both from a saved 客群 / existing campaign,
     mirroring the `cgMinScore` dynamic-option pattern (a group stored via
     API with an arbitrary floor, e.g. `icp_fit: 20`, gets its option
     appended instead of silently resetting).

## Files

- `src/admin.ts` — pre-filter form HTML (~3499), `pfParams` (~3567),
  campaign form HTML (~3886), `cgFilters`/`cgSetFilters` (~4204).
- `tests/campaign-targeting.test.ts` — +1 endpoint test (23 total in file):
  `/admin/api/customers/pre-filter` via `handleAdminRequest` — without the
  param the count is unchanged (3), with `has_buying_signal=1` it narrows
  to the company with a CURRENT signal (superseded-only does not count).

## Semantics pinned

- Dropdown facet counts (`pfDDCount`) still key off 有邮箱 only — the
  signal checkbox does not change per-condition hit numbers.
- Floors stay campaign-side per design §4: the pre-filter endpoint accepts
  only `has_buying_signal` (count + queue), no per-dimension floors.
- Stored payloads created before Phase 6 restore with both controls OFF
  (`cgSetFilters` defaults: `has_buying_signal !== true` → unchecked,
  missing `dimension_floors.icp_fit` → 不限).

## Evidence

- `vitest run` → **843 passed / 843 (67 files)**, was 842.
- `tsc --noEmit` → 0 errors.
- `wrangler deploy --dry-run` → Total Upload 573.55 KiB / gzip 140.32 KiB
  (was 572.52/140.06).

## Phase 6 closeout

Both stages shipped; phase6 design doc Status → "shipped in full". Out of
scope per design §6 remains out: persona-level per-person campaigns,
signal-text search, signal counts, outreach prompt changes, per-dimension
UI beyond ICP fit.
