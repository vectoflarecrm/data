/*
 * Phase 10 Stage 55 — operator-tunable lead-score dimension weights
 * (docs/phase10-lead-score-config.md §2). The audit's deferred item
 * (建议 §十八): retuning the six-dimension weighting must not require a
 * code deploy.
 *
 * Storage: one row (id = 1, CHECK-enforced) in lead_score_config —
 * migration 0029 / schema.sql. The row is written ONLY through the
 * validated PUT /admin/api/lead-score/config path.
 *
 * Fail-open stance: a missing table (migration-pending window), a missing
 * row (fresh install, never tuned), corrupt JSON or a hand-edited invalid
 * row all resolve to the code defaults (LEAD_SCORE_WEIGHTS in
 * lead-score-dims.ts) — scoring and research behave exactly as
 * pre-Stage-55. A silent fail-open would be a bug: the non-migration
 * failures are logged (the "no such table" case stays quiet, the
 * writeAuditLog precedent).
 */

import { safeLog } from "./security/safe-log";
import {
  LEAD_SCORE_DIMENSIONS,
  LEAD_SCORE_WEIGHTS,
  type LeadScoreWeights,
} from "./lead-score-dims";

/** Subset of the worker env this module needs (the D1 binding). */
export interface LeadScoreConfigEnv {
  DB: D1Database;
}

/* ── Validation ──────────────────────────────────────────────────────────
 *
 * The frozen total contract (docs/phase5-lead-score-v2.md §3.2/§4): the
 * score is 0-100, so the six weights must sum to EXACTLY 100 — enforced at
 * write, re-asserted at read. Anything else is rejected with a reason the
 * API surfaces verbatim; no silent clamping, no partial application.
 */

export interface LeadScoreWeightsOk {
  ok: true;
  weights: LeadScoreWeights;
}

export interface LeadScoreWeightsErr {
  ok: false;
  error: string;
}

export type LeadScoreWeightsResult = LeadScoreWeightsOk | LeadScoreWeightsErr;

const WEIGHTS_SUM = 100;
const MAX_DIMENSION_WEIGHT = 100;

const KNOWN_DIMENSIONS: ReadonlySet<string> = new Set<string>(LEAD_SCORE_DIMENSIONS);

/**
 * Parse and validate a weights payload (the PUT body, or the stored
 * weights_json). Requires an object with EXACTLY the six dimension keys —
 * a missing key is an incomplete retune, an extra key is a typo'd future
 * dimension silently ignored; both are errors, not warnings.
 */
export function parseLeadScoreWeights(raw: unknown): LeadScoreWeightsResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "weights must be a JSON object keyed by dimension" };
  }
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!KNOWN_DIMENSIONS.has(key)) {
      return { ok: false, error: `unknown dimension key: ${key}` };
    }
  }
  for (const dim of LEAD_SCORE_DIMENSIONS) {
    if (!(dim in obj)) {
      return { ok: false, error: `missing dimension weight: ${dim}` };
    }
  }
  const weights: LeadScoreWeights = {
    icp_fit: 0,
    product_fit: 0,
    buyer_role: 0,
    buying_signal: 0,
    reachability: 0,
    strategic_value: 0,
  };
  for (const dim of LEAD_SCORE_DIMENSIONS) {
    const v = obj[dim];
    // typeof first: Number.isSafeInteger(true) is false, so a boolean is
    // rejected — the Stage 53 contactsPerCompany lesson (Number(true) === 1
    // would slip a boolean through a Number()-based check).
    if (typeof v !== "number" || !Number.isSafeInteger(v)) {
      return { ok: false, error: `weight for ${dim} must be an integer` };
    }
    if (v < 0 || v > MAX_DIMENSION_WEIGHT) {
      return { ok: false, error: `weight for ${dim} must be between 0 and ${MAX_DIMENSION_WEIGHT}` };
    }
    weights[dim] = v;
  }
  const sum = LEAD_SCORE_DIMENSIONS.reduce((acc, dim) => acc + weights[dim], 0);
  if (sum !== WEIGHTS_SUM) {
    return { ok: false, error: `dimension weights must sum to exactly ${WEIGHTS_SUM}, got ${sum}` };
  }
  return { ok: true, weights };
}

/* ── Load / save ───────────────────────────────────────────────────────── */

export interface StoredLeadScoreConfig {
  weights: LeadScoreWeights;
  updatedAt: string | null;
}

function parseJsonSafe(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    return null;
  }
}

/** Same format writeAuditLog / sqlUtc use: UTC "YYYY-MM-DD HH:MM:SS". */
function sqlUtcNow(): string {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

/**
 * The effective weights: the stored row when present and valid, the code
 * defaults otherwise (missing table = migration-pending, missing row =
 * never tuned, invalid row = corrupt/hand-edited — each fail-open, the
 * non-expected ones logged).
 */
export async function loadLeadScoreConfig(env: LeadScoreConfigEnv): Promise<StoredLeadScoreConfig> {
  let row: { weights_json: string; updated_at: string } | null = null;
  try {
    row =
      (await env.DB.prepare(`SELECT weights_json, updated_at FROM lead_score_config WHERE id = 1`)
        .first<{ weights_json: string; updated_at: string }>()) ?? null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes("no such table")) {
      safeLog("warn", "[lead-score-config] lookup failed, using defaults", e);
    }
    return { weights: LEAD_SCORE_WEIGHTS, updatedAt: null };
  }
  if (!row) {
    return { weights: LEAD_SCORE_WEIGHTS, updatedAt: null };
  }
  const parsed = parseLeadScoreWeights(parseJsonSafe(row.weights_json));
  if (!parsed.ok) {
    safeLog(
      "warn",
      "[lead-score-config] stored weights invalid, using defaults",
      new Error(parsed.error),
    );
    return { weights: LEAD_SCORE_WEIGHTS, updatedAt: null };
  }
  return { weights: parsed.weights, updatedAt: row.updated_at };
}

/** Thin wrapper for callers that only need the weights (the engine paths). */
export async function loadLeadScoreWeights(env: LeadScoreConfigEnv): Promise<LeadScoreWeights> {
  return (await loadLeadScoreConfig(env)).weights;
}

/**
 * Upsert the single config row. Throws on a missing table (fail-loud: a
 * config PUT that silently pretended to save would be a lie — unlike the
 * read paths, the writer must not degrade). Returns the updated_at written.
 */
export async function saveLeadScoreWeights(
  env: LeadScoreConfigEnv,
  weights: LeadScoreWeights,
  updatedBy: string | null,
): Promise<string> {
  const updatedAt = sqlUtcNow();
  await env.DB.prepare(
    `INSERT INTO lead_score_config (id, weights_json, updated_at, updated_by)
     VALUES (1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       weights_json = excluded.weights_json,
       updated_at = excluded.updated_at,
       updated_by = excluded.updated_by`,
  ).bind(JSON.stringify(weights), updatedAt, updatedBy).run();
  return updatedAt;
}
