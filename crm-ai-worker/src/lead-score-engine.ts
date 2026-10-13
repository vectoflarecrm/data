/* Phase 5 (建议 §十八, design docs/phase5-lead-score-v2.md) + Phase 10
 * (docs/phase10-lead-score-config.md §3): the six-dimension lead-score
 * engine, extracted from index.ts as a LEAF module in Stage 57.
 *
 * Why a leaf: the admin re-score sweep (POST /admin/api/lead-score/rescore)
 * must call computeLeadScoreV2, but admin.ts cannot import the worker entry
 * (index → admin would cycle). Same pattern as lead-score-dims (Phase 6
 * Stage 45: campaign targeting) and lead-score-config (Phase 10 Stage 55):
 * the engine depends only on lead-score-dims + a type from research-run,
 * never on index/admin. index.ts re-exports computeLeadScoreV2 so
 * tests/lead-score-v2.test.ts keeps importing from ../src/index unchanged.
 *
 * The score is a 0-100 SQL-targetable score (docx 建议二/九) decomposed into
 * six named dimensions — ICP fit / product fit / buyer role / buying signal
 * / reachability / strategic value. Deterministic rules over
 * already-verified facts — no AI calls, no DB reads. Pure over the inputs.
 */

import { LEAD_SCORE_WEIGHTS, type LeadScoreWeights } from "./lead-score-dims";
import type { ResearchPersonaEntry } from "./research-run";

/** The engine's inputs: the NARROW structural slice of CustomerAnalysis
 * (equivalently, of the customers + contacts columns) that the six rules
 * actually read. A full analysis satisfies it structurally (no cast); the
 * Stage 57 re-score sweep builds it directly from stored rows, so scores
 * can follow a weight retune without re-running research. */
export interface LeadScoreInputs {
  customer_segment: string;
  product_categories: string | null;
  company_size: string | null;
  geographic_coverage: string | null;
  personas_and_solutions: unknown;
  buying_signals: string[];
  found_contacts: Array<{
    first_name?: string | null;
    last_name?: string | null;
    email?: string | null;
    cellphone?: string | null;
    whatsapp?: string | null;
  }>;
}

/** The score's six-dimension decomposition. The total contract is frozen
 * (0-100, same consumers); the breakdown is cached on
 * customers.lead_score_breakdown beside the total. */
export interface LeadScoreBreakdown {
  version: "lead-score-v2";
  icp_fit: number;
  product_fit: number;
  buyer_role: number;
  buying_signal: number;
  reachability: number;
  strategic_value: number;
}

/** Phase 4 Stage 41: pull the personas array out of the raw
 * personas_and_solutions payload (typed `unknown` — the JSON contract is
 * enforced by the AI response schema, not the TS type). Blank names drop;
 * the writer applies its own dedup + caps. Moved here with the engine in
 * Stage 57: computeLeadScoreV2 reads persona roles through it, so the
 * re-score path shares the one extraction. */
export function extractPersonaEntries(payload: unknown): ResearchPersonaEntry[] {
  if (typeof payload !== "object" || payload === null) return [];
  const personas = (payload as Record<string, unknown>).personas;
  if (!Array.isArray(personas)) return [];
  const strList = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim())
      : [];
  const out: ResearchPersonaEntry[] = [];
  for (const p of personas) {
    if (typeof p !== "object" || p === null) continue;
    const rec = p as Record<string, unknown>;
    const name = typeof rec.name === "string" ? rec.name.trim() : "";
    if (!name) continue;
    out.push({
      persona_name: name,
      persona_role: typeof rec.role === "string" ? rec.role.trim() || null : null,
      needs: strList(rec.needs),
      pain_points: strList(rec.pain_points),
    });
  }
  return out;
}

// Phase 10 (design docs/phase10-lead-score-config.md §3): the dimension
// weights are operator-tunable (lead_score_config, Stage 55). The tiers are
// RATIOS of the configured weight — Math.round(ratio × weight) — so a retune
// rescales every tier proportionally without a deploy. Under the default
// weights every ratio resolves to the Phase 5 integers exactly (25 = 5/6·30,
// 15 = ½·30, 10 = ⅓·30, 5 = ⅙·30, 8 = 8/15·15, 4 = 4/15·15): the golden
// suite (tests/lead-score-v2.test.ts) pins that byte-identity. Callers that
// omit the weights (tests, ad-hoc analysis) get the code defaults.
export function computeLeadScoreV2(
  a: LeadScoreInputs,
  weights: LeadScoreWeights = LEAD_SCORE_WEIGHTS,
): LeadScoreBreakdown {
  // Irrelevant companies are worthless by definition — the AI precheck marks
  // them segment=不相关 with score 0, so the SQL-based histogram/filter can
  // never surface one as a lead regardless of which fields were populated.
  if (a.customer_segment.includes("不相关")) {
    return {
      version: "lead-score-v2",
      icp_fit: 0,
      product_fit: 0,
      buyer_role: 0,
      buying_signal: 0,
      reachability: 0,
      strategic_value: 0,
    };
  }
  // ICP fit: wholesale buyers outweigh end users (V1 segment tiering).
  let icpRatio = 0;
  const seg = a.customer_segment.toLowerCase();
  if (seg.includes("distributor")) icpRatio = 1;
  else if (seg.includes("dealer") || seg.includes("oem") || seg.includes("wholesaler")) icpRatio = 5 / 6;
  else if (seg.includes("e-commerce")) icpRatio = 1 / 2;
  else if (seg.includes("retailer")) icpRatio = 1 / 3;
  else if (seg.includes("user") || seg.includes("service")) icpRatio = 1 / 6;
  const icpFit = Math.round(icpRatio * weights.icp_fit);
  // Product fit: matches our catalogue.
  const cats = (a.product_categories ?? "").toLowerCase();
  const productFit = cats && !cats.includes("信息不足") ? weights.product_fit : 0;
  // Buyer role: a named decision-maker beats role-only personas.
  const hasNamedContact = a.found_contacts.some((c) => c.first_name || c.last_name);
  const hasRolePersona = extractPersonaEntries(a.personas_and_solutions).some((p) => p.persona_role);
  const buyerRole = hasNamedContact
    ? weights.buyer_role
    : hasRolePersona
      ? Math.round((1 / 2) * weights.buyer_role)
      : 0;
  // Buying signal: active purchase intent.
  const buyingSignal = a.buying_signals.length > 0 ? weights.buying_signal : 0;
  // Reachability: an email is the strongest outreach channel, phone/WhatsApp
  // the runner-up, any other contact a weak signal.
  let reachRatio = 0;
  if (a.found_contacts.some((c) => c.email)) reachRatio = 1;
  else if (a.found_contacts.some((c) => c.cellphone || c.whatsapp)) reachRatio = 8 / 15;
  else if (a.found_contacts.length > 0) reachRatio = 4 / 15;
  const reachability = Math.round(reachRatio * weights.reachability);
  // Strategic value: verified coverage/size fields. The two components share
  // ONE round of the combined ratio (½ per verified field) — rounding each
  // half separately could push an odd weight past its own maximum
  // (Math.round(½·15) + Math.round(½·15) = 16 > 15); one round keeps every
  // dimension ≤ its configured weight, byte-identical under the defaults.
  let strategicRatio = 0;
  if (a.company_size && !a.company_size.includes("信息不足")) strategicRatio += 1 / 2;
  if (a.geographic_coverage && !a.geographic_coverage.includes("信息不足")) strategicRatio += 1 / 2;
  const strategicValue = Math.round(strategicRatio * weights.strategic_value);
  return {
    version: "lead-score-v2",
    icp_fit: icpFit,
    product_fit: productFit,
    buyer_role: buyerRole,
    buying_signal: buyingSignal,
    reachability,
    strategic_value: strategicValue,
  };
}
