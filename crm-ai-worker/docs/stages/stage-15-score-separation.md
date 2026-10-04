# Stage 15 Report — Lead Score / Data Completeness Separation

Branch: `feature/security-v2` · Follows: Stage 14 (Evidence V2)

## Goal (spec §16)
Lead score was the only business quality metric, conflating "is this company
worth pursuing?" with "how well do we actually know this record?" — a
perfect-fit distributor with a bare, unreachable record scored as high as a
fully documented one. Stage 15 adds `data_completeness_score` as a second,
independent axis: lead score keeps answering fit (§16.1), completeness
answers record knowledge (§16.2), and neither is ever derived from or
overwritten by the other (§16.3).

## Changes

### `src/index.ts`
- **`computeCompletenessScore` (new, exported)** — deterministic 10×10
  formula over §16.2 dimensions: company identity, domain, country, contact
  person, email, phone, social (verified count), products, evidence,
  freshness (the stamping research pass itself — data is fresh at write
  time; staleness accrues until the next run re-stamps).
- **`computeLeadScore` untouched** — it already covers the §16.1 fit
  dimensions (ICP fit = segment weights, product fit = category match, buyer
  role = named decision-maker, buying signal, reachability = email/contact,
  strategic relevance = verified size/coverage). Its exact behavior is
  pinned by the existing `relevance.test.ts` and `prompt-injection.test.ts`
  suites, which must keep passing unmodified.
- **`processCustomer`**: computes both scores and writes them to separate
  columns in the success UPDATE. The relevance-precheck skip path still
  writes `lead_score = 0` only — an "irrelevant" verdict changes fit, not
  how well we know the record, so completeness is left untouched (§16.3
  independence in both directions).
- Relationship honesty: the two axes share underlying facts where the spec's
  own dimension lists overlap (product categories are §16.1 *product fit*
  AND §16.2 *products*; an email contact is §16.1 *reachability* AND §16.2
  *email*). Independence is at the formula/column level — separate lenses,
  separate verdicts, no cross-derivation — which is what §16.3's "不能自动
  互相覆盖" requires.

### `src/admin.ts`
- **Detail API** (`GET /admin/api/customers/:id`): response now carries
  `data_completeness_score` next to the existing `lead_score`. Read through
  `getCustomerCompleteness`, a missing-column-tolerant helper — a
  migration-pending database degrades to `null` instead of erroring, and the
  shared `CUSTOMER_COLUMNS` list stays untouched so every existing
  fixture/panel keeps working.
- **Detail modal**: two readonly rows at the end of the field list — 线索评
  分 (Lead Score) and 数据完整度 (Data Completeness). Readonly means never
  hand-editable, never in a PATCH payload: both scores are system-computed
  only.

### Migration / deploy
- `migrations/0013_customers_completeness_score.sql`: one ALTER. No
  backfill — existing rows keep NULL, meaning "not yet scored by the new
  formula" (distinct from 0 = "we know this record is nearly empty"); the
  next research run stamps the value.
- `.github/workflows/deploy-worker.yml`: new per-statement ALTER step with
  pragma verification, same pattern as Stage 14.
- `schema.sql`: comment block updated to name the second axis and the CI
  ALTER convention. `README.md`: formula card for the new score.

## Tests (+8 → 359 total)
`tests/score-separation.test.ts` (§16.3 mapped in the header):
- §16.2 accounting: fully known record = 100; each dimension exactly 10
  points; a phone-only contact counts both the contact-person and phone
  dimensions; `信息不足` verdicts are absence, not data;
- **high lead / low completeness**: distributor + products + signal (lead ≥
  60) with a bare record (completeness 30 — the products fact is a genuinely
  shared input);
- **low lead / high completeness**: judged 不相关 (lead 0 by definition)
  yet fully known (completeness 100) — the strongest independence
  demonstration: fit 0 says nothing about record knowledge;
- **no auto-overwrite**: adding evidence rows never moves the lead score
  (identity/country/social live on the customer row the lead score does not
  even receive); toggling segment/buying-signals never moves the
  completeness score;
- admin detail API: both scores as separate response fields; a
  migration-pending table degrades completeness to null while lead_score is
  unaffected.

## Verification
- `npx tsc --noEmit`: pass
- `npm test`: **351/351 pass** (was 343, +8; 24 files)
- `node scripts/check-panel.mjs`: 4 panels clean
- `npx wrangler deploy --dry-run` (offline): pass

## Security Risks Fixed
- Baseline **#16 (P2)**: lead score no longer conflates fit and completeness.
  The two axes are separate formulas, separate columns, separate semantics —
  budget decisions (who to pursue) can no longer be silently driven by data
  richness, and data-quality work (who to re-research/enrich) is now visible
  in its own metric.

## Notes and boundaries
- Both scores remain 0-100 integers, SQL-targetable; campaigns keep
  filtering on `min_lead_score` only (fit targeting — unchanged semantics).
- A future `min_data_completeness` filter is a natural follow-up but out of
  this stage's scope; the column is already indexed-ready for it.
- Freshness is stamped per research pass; a record never re-researched keeps
  its old completeness score, which then overstates freshness — acceptable
  because the score's semantics are "state at last verification", and the
  evidence trail (Stage 14) records when that was.
