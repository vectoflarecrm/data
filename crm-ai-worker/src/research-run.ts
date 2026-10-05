/* Security V2 Stage 14 (spec §15) — Evidence V2: research runs + append-only
 * evidence.
 *
 * Before this stage, re-researching a company did `DELETE FROM evidence WHERE
 * company_id = ?` before re-inserting — every new crawl DESTROYED the previous
 * verification trail, so a wrong judgement could never be compared against the
 * facts it replaced (spec §15.2: "不能直接 UPDATE old evidence").
 *
 * New model:
 *   - every processCustomer attempt opens a research_runs row (status running
 *     → completed/failed, with parser + model provenance);
 *   - evidence rows are APPENDED and reference that run; the previous rows for
 *     a re-asserted field are superseded via is_current = 0 + valid_until, so
 *     the history stays queryable and "current facts" are decided by
 *     is_current / valid_from / valid_until instead of deletion;
 *   - each row carries source_id / source_hash / content_hash:
 *       source_id    — stable identity of the source document (hash of the
 *                      source URL; "ai-analysis" for model-judged fields);
 *       source_hash  — identity of what the source said (hash of the quoted
 *                      evidence text) — detects source drift between runs;
 *       content_hash — identity of the fact (hash of field_name + field_value)
 *                      — the same fact re-observed yields the same hash.
 *
 * Failure policy: provenance is an auditability layer, not a safety control —
 * the pipeline's hard guarantees (at-most-once sends, quota caps) live in
 * earlier stages. A provenance write that cannot complete (migration-pending
 * table/column, transient D1 error) is skipped with a warning instead of
 * failing research that already spent search credits and AI tokens. The
 * write itself is a single D1 batch: the supersede UPDATEs and the new-row
 * INSERTs apply atomically, so no partial state can appear.
 */

import { safeLog } from "./security/safe-log";

/** Version of the research → evidence writer. Stamped on runs and rows so a
 * future parser change can distinguish which code produced which facts. */
export const EVIDENCE_PARSER_VERSION = "evidence-v2";

/** Version of the raw-source writer (research_sources rows). Distinct from
 * the evidence writer so a raw snapshot is attributable to the code path
 * that captured it. Legacy backfill rows use 'backfill-v1' instead. */
export const SOURCES_PARSER_VERSION = "sources-v1";

/** Which provider/model actually produced an analysis. Stamped by the
 * analyzeWithX callers in index.ts at their single success return point. */
export interface AnalysisProvenance {
  provider: string | null;
  model: string | null;
}

export function newProvenance(): AnalysisProvenance {
  return { provider: null, model: null };
}

export interface ResearchRunEnv {
  DB: D1Database;
}

/** One field-level fact as produced by the AI analysis (subset of
 * CustomerAnalysis["field_evidence"] elements). */
export interface EvidenceEntry {
  field_name: string;
  field_value: string;
  source_url?: string;
  evidence_text?: string;
  confidence?: number;
}

function sqlUtc(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
  );
}

/** First 8 bytes of SHA-256 as hex — collision-safe identity prefix. */
async function sha256Hex16(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest).slice(0, 8);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

function warnSkip(e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e);
  safeLog("warn", `[research-run] provenance write skipped (fail-open): ${msg}`);
}

/** Open a research run for one attempt. Returns the run id, or null when the
 * research_runs table is missing/pending (fail-open: research proceeds). */
export async function startResearchRun(
  env: ResearchRunEnv,
  companyId: string,
  now: Date = new Date(),
): Promise<string | null> {
  const id = crypto.randomUUID();
  try {
    await env.DB.prepare(
      `INSERT INTO research_runs (id, customer_id, status, started_at) VALUES (?, ?, 'running', ?)`,
    ).bind(id, companyId, sqlUtc(now)).run();
    return id;
  } catch (e) {
    warnSkip(e);
    return null;
  }
}

/** Close a run: completed, or failed with the error text. No-op for a null
 * run id (start failed open), so callers never need to branch. */
export async function completeResearchRun(
  env: ResearchRunEnv,
  runId: string | null,
  provenance: AnalysisProvenance,
  opts: { error?: string } = {},
  now: Date = new Date(),
): Promise<void> {
  if (!runId) return;
  const status = opts.error ? "failed" : "completed";
  try {
    await env.DB.prepare(
      `UPDATE research_runs
       SET status = ?, completed_at = ?, parser_version = ?, model_name = ?, model_version = ?, error = ?
       WHERE id = ?`,
    ).bind(status, sqlUtc(now), EVIDENCE_PARSER_VERSION, provenance.provider, provenance.model, opts.error ?? null, runId).run();
  } catch (e) {
    warnSkip(e);
  }
}

export interface AppendEvidenceParams {
  companyId: string;
  runId: string | null;
  provenance: AnalysisProvenance;
  entries: EvidenceEntry[];
  now?: Date;
}

/** Append one attempt's field evidence. Prior current rows for the same
 * fields are superseded (is_current = 0, valid_until = now) — never deleted
 * — and the new rows land with the full provenance set, is_current = 1 and
 * valid_from = now. One D1 batch: atomic supersede + append. */
export async function appendFieldEvidence(env: ResearchRunEnv, params: AppendEvidenceParams): Promise<void> {
  const { companyId, runId, provenance, entries } = params;
  if (entries.length === 0) return;
  const now = params.now ?? new Date();
  try {
    const fieldNames = Array.from(new Set(entries.map((e) => e.field_name)));
    const stmts: D1PreparedStatement[] = fieldNames.map((fieldName) =>
      env.DB.prepare(
        `UPDATE evidence SET is_current = 0, valid_until = ?
         WHERE company_id = ? AND field_name = ? AND is_current = 1`,
      ).bind(sqlUtc(now), companyId, fieldName),
    );
    for (const e of entries) {
      const sourceId = await sha256Hex16(e.source_url || "ai-analysis");
      const sourceHash = await sha256Hex16(e.evidence_text || e.field_value || "");
      const contentHash = await sha256Hex16(`${e.field_name}\u0000${e.field_value}`);
      stmts.push(
        env.DB.prepare(
          `INSERT INTO evidence
             (company_id, field_name, field_value, source_url, source_type, evidence_text, confidence,
              research_run_id, source_id, source_hash, content_hash, parser_version, model_name, model_version,
              retrieved_at, is_current, valid_from)
           VALUES (?, ?, ?, ?, 'ai_analysis', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        ).bind(
          companyId,
          e.field_name,
          e.field_value,
          e.source_url ?? null,
          e.evidence_text ?? null,
          e.confidence ?? null,
          runId,
          sourceId,
          sourceHash,
          contentHash,
          EVIDENCE_PARSER_VERSION,
          provenance.provider,
          provenance.model,
          sqlUtc(now),
          sqlUtc(now),
        ),
      );
    }
    await env.DB.batch(stmts);
  } catch (e) {
    warnSkip(e);
  }
}

/** Total raw text kept per research run, in characters. Mirrors the 50 000
 * char cap the blob (customers.full_research_text) has always enforced, so
 * per-run source history never stores more than the pipeline already saved. */
export const RESEARCH_SOURCE_TOTAL_CAP = 50_000;

/** One raw crawl segment for research_sources (Phase 3): the pipeline
 * produces these in blob order — website, verified socials, search results,
 * additional sources — so the budget split matches what the concatenated
 * blob preserved. */
export interface ResearchSourceEntry {
  source_type: string;
  source_url?: string | null;
  raw_text: string;
}

/** Shared-budget cap: walks entries in order, slicing each into what remains
 * of RESEARCH_SOURCE_TOTAL_CAP. Entries that end up with empty raw text and
 * no URL (nothing to record) are dropped; an empty-text entry WITH a URL
 * survives — it records "this run tried the site and got nothing". */
export function capResearchSourcesToBudget(
  entries: ResearchSourceEntry[],
  cap: number = RESEARCH_SOURCE_TOTAL_CAP,
): ResearchSourceEntry[] {
  const out: ResearchSourceEntry[] = [];
  let remaining = cap;
  for (const e of entries) {
    if (remaining <= 0 && !(e.raw_text === "" && e.source_url)) break;
    const text = e.raw_text.slice(0, Math.max(0, remaining));
    remaining -= text.length;
    if (text === "" && !e.source_url) continue;
    out.push({ source_type: e.source_type, source_url: e.source_url ?? null, raw_text: text });
  }
  return out;
}

export interface AppendSourcesParams {
  companyId: string;
  runId: string | null;
  sources: ResearchSourceEntry[];
  now?: Date;
}

/** Append one attempt's raw sources. The previous current set for the
 * company is superseded (is_current = 0, valid_until = now) — never deleted
 * — and the new rows land with content hashes, is_current = 1 and
 * valid_from = now. One D1 batch: atomic supersede + append. Input is
 * budget-capped first (writer-level enforcement: no caller can store more
 * raw text per run than the blob cap). */
export async function appendResearchSources(env: ResearchRunEnv, params: AppendSourcesParams): Promise<void> {
  const { companyId, runId } = params;
  const now = params.now ?? new Date();
  const capped = capResearchSourcesToBudget(params.sources);
  if (capped.length === 0) return;
  try {
    const stmts: D1PreparedStatement[] = [
      env.DB.prepare(
        `UPDATE research_sources SET is_current = 0, valid_until = ?
         WHERE customer_id = ? AND is_current = 1`,
      ).bind(sqlUtc(now), companyId),
    ];
    for (const s of capped) {
      const contentHash = await sha256Hex16(s.raw_text);
      stmts.push(
        env.DB.prepare(
          `INSERT INTO research_sources
             (research_run_id, customer_id, source_type, source_url, raw_text,
              content_hash, parser_version, fetched_at, is_current, valid_from)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        ).bind(runId, companyId, s.source_type, s.source_url ?? null, s.raw_text,
          contentHash, SOURCES_PARSER_VERSION, sqlUtc(now), sqlUtc(now)),
      );
    }
    await env.DB.batch(stmts);
  } catch (e) {
    warnSkip(e);
  }
}
