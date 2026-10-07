/* Phase 6 Stage 45 (建议 §十八/§二十一): the six lead-score dimensions and
 * their weights, extracted from index.ts into a leaf module so campaign
 * targeting (src/campaigns.ts) can validate dimension floors against the
 * same single source of truth — campaigns.ts cannot import the worker
 * entry (index → admin → campaigns would be a cycle). index.ts re-exports
 * everything, so existing imports (the engine, tests/lead-score-v2.test.ts)
 * are untouched.
 *
 * Pinned in docs/phase5-lead-score-v2.md §4: the weights sum to exactly 100
 * (asserted in tests/lead-score-v2.test.ts). The panel keeps its own
 * documented JS mirror (Stage 44); this module is the server-side home.
 */

export const LEAD_SCORE_DIMENSIONS = [
  "icp_fit",
  "product_fit",
  "buyer_role",
  "buying_signal",
  "reachability",
  "strategic_value",
] as const;

export type LeadScoreDimension = (typeof LEAD_SCORE_DIMENSIONS)[number];

export const LEAD_SCORE_WEIGHTS: Record<LeadScoreDimension, number> = {
  icp_fit: 30,
  product_fit: 20,
  buyer_role: 10,
  buying_signal: 15,
  reachability: 15,
  strategic_value: 10,
};
