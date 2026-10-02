import type { AdminEnv } from "./admin";

/* ── Filter dropdown facets ──────────────────────────────────────────────
 *
 * The 海选过滤器 and 定向群发 filter bars used to be free-text inputs: the
 * operator had to guess the exact stored spelling ("Morocco" vs "MOROCCO") and
 * had no idea how many customers a value would pull in. This module builds the
 * selection lists instead — values mined from the live customer table, each
 * carrying the count it will really match.
 *
 * Every count is computed with the SAME `LIKE '%val%'` expression that
 * buildSegmentWhere() (src/campaigns.ts) builds for the actual filter, so the
 * number next to an option is exactly what 统计匹配 / 统计客群 will return once
 * that option is ticked — including SQLite's ASCII-case-insensitive LIKE, which
 * is why "MOROCCO" and "Morocco" collapse into one option whose count covers
 * both spellings.
 *
 *   n  — completed-research rows this value matches (海选 base)
 *   ne — the same rows that also have an address (定向群发 base, which always
 *        requires one; likewise 海选 with 有邮箱 ticked)
 *
 * Discovery (GROUP BY / bounded sample) is separate from counting so the LIKE
 * pass never sees more candidates than the caps below: D1 limits a statement to
 * 100 bound parameters, and at 50k rows a token per row would not be free.
 */

export interface FacetOption {
  /** The value to feed back into the filter — exactly as stored. */
  v: string;
  /** Completed rows matching `v`. */
  n: number;
  /** Of those, rows with an address. */
  ne: number;
}

export interface FilterOptions {
  countries: FacetOption[];
  segments: FacetOption[];
  products: FacetOption[];
  keywords: FacetOption[];
}

export type FacetKind = keyof FilterOptions;

const ALL_FACETS: FacetKind[] = ["countries", "segments", "products", "keywords"];

/** `?facets=` selector: absent/blank means every facet, unknown names ignored. */
export function parseFacets(raw: string | null): FacetKind[] {
  if (!raw || !raw.trim()) return [...ALL_FACETS];
  const want = new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
  return ALL_FACETS.filter((kind) => want.has(kind));
}

const BIND_CHUNK = 90; // D1 caps bound parameters at 100 per statement
const GROUP_LIMIT = 100; // distinct countries / segments worth listing
const PRODUCT_COMBOS = 500; // distinct product_categories combos to split
const PRODUCT_LIMIT = 60;
const KEYWORD_SAMPLE_ROWS = 2000; // rows to read when mining keyword terms
const KEYWORD_MIN_HITS = 4;
const KEYWORD_LIMIT = 60;

/* The same predicates buildSegmentWhere() runs, parameterised by the token
 * column reference so one code path serves every facet. Keep them in sync with
 * src/campaigns.ts — a count that drifts from the filter is worse than none. */
const MATCHES: Record<FacetKind, (tok: string) => string> = {
  countries: (t) => `c.country LIKE '%' || ${t} || '%'`,
  segments: (t) => `c.customer_segment LIKE '%' || ${t} || '%'`,
  products: (t) =>
    `(c.product_categories LIKE '%' || ${t} || '%' OR c.products_services LIKE '%' || ${t} || '%')`,
  keywords: (t) =>
    `(c.company_name LIKE '%' || ${t} || '%' OR c.description LIKE '%' || ${t} || '%'` +
    ` OR c.business_tag LIKE '%' || ${t} || '%')`,
};

/** SQLite only folds ASCII case, so the merge key must fold exactly that:
 * "ESPAÑA" and "España" are different LIKE matches and stay separate. */
function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/** One option per ASCII-case variant group: the most frequent spelling, with a
 * summed count used only to rank candidates before the LIKE pass. */
function mergeCaseVariants(values: Array<{ v: string; n: number }>): Array<{ v: string; n: number }> {
  const merged = new Map<string, { v: string; n: number; top: number }>();
  for (const item of values) {
    const key = asciiLower(item.v);
    const prev = merged.get(key);
    if (!prev) {
      merged.set(key, { v: item.v, n: item.n, top: item.n });
      continue;
    }
    prev.n += item.n;
    if (item.n > prev.top) {
      prev.top = item.n;
      prev.v = item.v;
    }
  }
  return [...merged.values()].map(({ v, n }) => ({ v, n }));
}

/** Exact match counts per candidate, in bounded chunks. Tokens missing from
 * the result match nothing and are dropped by the caller. */
async function countTokens(
  env: AdminEnv,
  kind: FacetKind,
  tokens: string[],
): Promise<Map<string, { n: number; ne: number }>> {
  const out = new Map<string, { n: number; ne: number }>();
  const matches = MATCHES[kind];
  for (let i = 0; i < tokens.length; i += BIND_CHUNK) {
    const chunk = tokens.slice(i, i + BIND_CHUNK);
    const sql = `
      WITH tok(t) AS (VALUES ${chunk.map(() => "(?)").join(",")})
      SELECT tok.t AS v, COUNT(*) AS n,
             SUM(CASE WHEN c.email IS NOT NULL AND c.email != '' THEN 1 ELSE 0 END) AS ne
      FROM tok, customers c
      WHERE c.status = 'completed' AND ${matches("tok.t")}
      GROUP BY tok.t`;
    const rows = await env.DB.prepare(sql).bind(...chunk).all<{ v: string; n: number; ne: number | null }>();
    for (const row of rows.results ?? []) out.set(row.v, { n: row.n, ne: row.ne ?? 0 });
  }
  return out;
}

/** Candidate values of one column plus row counts (ranking only — the real
 * count comes from the LIKE pass, which also catches cross-value substrings). */
async function distinctColumnValues(
  env: AdminEnv,
  column: "country" | "customer_segment",
): Promise<Array<{ v: string; n: number }>> {
  const rows = await env.DB.prepare(
    `SELECT TRIM(${column}) AS v, COUNT(*) AS n FROM customers
     WHERE status = 'completed' AND TRIM(${column}) != ''
     GROUP BY TRIM(${column}) ORDER BY n DESC, v LIMIT ${GROUP_LIMIT}`,
  ).all<{ v: string; n: number }>();
  return (rows.results ?? []).map((row) => ({ v: row.v, n: row.n }));
}

async function distinctProductCombos(env: AdminEnv): Promise<Array<{ combo: string; n: number }>> {
  const rows = await env.DB.prepare(
    `SELECT TRIM(product_categories) AS combo, COUNT(*) AS n FROM customers
     WHERE status = 'completed' AND TRIM(product_categories) != ''
     GROUP BY TRIM(product_categories) ORDER BY n DESC, combo LIMIT ${PRODUCT_COMBOS}`,
  ).all<{ combo: string; n: number }>();
  return rows.results ?? [];
}

/* Pipeline verdicts stored in product_categories, AI hedging prose longer than
 * any real category, and the usual "no value" placeholders: none of them is a
 * product an operator would tick. */
const NOT_PRODUCTS = new Set(["不相关", "none", "n/a", "null", "无"]);
function isProductValue(value: string): boolean {
  if (!value || value.length > 40) return false;
  if (value.startsWith("信息不足")) return false;
  return !NOT_PRODUCTS.has(value.toLowerCase());
}

/** product_categories is a comma-separated AI extraction; split it into the
 * values an operator can actually tick. */
export function productTokens(combos: Array<{ combo: string; n: number }>): Array<{ v: string; n: number }> {
  const merged = new Map<string, { v: string; n: number; top: number }>();
  for (const { combo, n } of combos) {
    // A repeated token inside one combo must not be counted twice.
    for (const raw of new Set(combo.split(",").map((part) => part.trim()))) {
      if (!isProductValue(raw)) continue;
      const key = asciiLower(raw);
      const prev = merged.get(key);
      if (!prev) {
        merged.set(key, { v: raw, n, top: n });
        continue;
      }
      prev.n += n;
      if (n > prev.top) {
        prev.top = n;
        prev.v = raw;
      }
    }
  }
  return [...merged.values()].map(({ v, n }) => ({ v, n }));
}

/* Pipeline-written status notes inside description, e.g. "[User] 验证为有效邮箱".
 * Stripping them keeps the keyword list to terms that describe the BUSINESS,
 * which is what the 关键词 filter is for. Bracket tags ([Dealer] …) are removed
 * too — they duplicate the 细分 select, and keeping both would offer "dealer"
 * twice under two different labels. */
const NOTE_CJK =
  /^(验证|有效|邮箱|官网|网站|域名|正常营业|合并|已补充|未找到|错误|优质客户|无网站|已查|高优先|优先级|联系人|负责人|可用|实体店|已剔除|存在|营业|信息不足|有限公司|错误邮箱|已剔除邮箱)/;
const NOTE_LATIN = new Set([
  "linkedin", "google", "map", "facebook", "whatsapp", "instagram", "youtube",
  "twitter", "tiktok", "email", "mail", "phone", "www", "http", "https",
  "company", "contact", "info", "profile", "page", "founder", "owner",
]);
/* English filler: function words plus the generic business nouns that appear in
 * half the descriptions ("equipment", "retail" …) and would match everything,
 * which makes them useless as a filter. Words under 4 chars never reach this
 * list — the token regex already drops them. */
const EN_STOP = new Set(`
a an the and or of for to in on at by with from is are was were be been has have
this that it its as not no but if then than into over under out up down about after before
also more most some such own same too very can will just now what when where which
who whom their them they these those there here been does did done doing
com org net
retail sale sales sell buying shop stores services service equipment products
product supplies supplying customer customers market markets offers offering
providing based leading line lines inc ltd gmbh srl sl sa bv co corp
`.split(/\s+/).filter(Boolean));

export interface KeywordSampleRow {
  company_name?: string | null;
  description?: string | null;
  business_tag?: string | null;
}

/** Business terms worth offering in the 关键词 dropdown, mined from a bounded
 * sample of the columns the keyword filter LIKEs against. Hits are sample
 * occurrences (the exact count comes from the LIKE pass); terms need at least
 * KEYWORD_MIN_HITS rows to earn a slot, so one-off company names never show up.
 *
 * Exported for tests: the stoplists are the whole quality story here and a
 * regression would only surface as junk options in the panel. */
export function keywordCandidates(rows: KeywordSampleRow[]): Array<{ v: string; hits: number }> {
  const hits = new Map<string, number>();
  for (const row of rows) {
    const name = String(row.company_name ?? "");
    const desc = String(row.description ?? "");
    const tag = String(row.business_tag ?? "");
    // First clause only: everything after 。 is Google-Map / link-verification
    // prose the pipeline appends, not something anyone filters by.
    const head = desc.split(/[。\n]/)[0].replace(/\[[^\]]{1,30}\]/g, " ");
    const seen = new Set<string>();
    // Accented Latin stays in the token so LIKE '%Nàutica%' still matches the
    // row it was read from; normalising would produce a term that matches nothing.
    for (const word of (name + " " + head + " " + tag).match(/[A-Za-zÀ-ɏ][A-Za-z0-9À-ɏ]{3,}/g) ?? []) {
      const token = word.toLowerCase();
      if (!EN_STOP.has(token) && !NOTE_LATIN.has(token)) seen.add(token);
    }
    // CJK runs come from the description clause only: a Chinese company name
    // would otherwise offer the company itself as a keyword.
    for (const run of head.split(/[^一-鿿]+/)) {
      const token = run.trim();
      if (token.length >= 2 && token.length <= 12 && !NOTE_CJK.test(token)) seen.add(token);
    }
    const hay = (name + " " + desc + " " + tag).toLowerCase();
    for (const token of seen) {
      if (hay.includes(token)) hits.set(token, (hits.get(token) ?? 0) + 1);
    }
  }
  return [...hits]
    .filter(([, count]) => count >= KEYWORD_MIN_HITS)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, KEYWORD_LIMIT)
    .map(([v, count]) => ({ v, hits: count }));
}

function toOptions(
  candidates: Array<{ v: string; n: number }>,
  counts: Map<string, { n: number; ne: number }> | undefined,
): FacetOption[] {
  return candidates
    .map((c) => ({ v: c.v, n: counts?.get(c.v)?.n ?? 0, ne: counts?.get(c.v)?.ne ?? 0 }))
    .filter((option) => option.n > 0)
    .sort((a, b) => b.n - a.n || (a.v < b.v ? -1 : a.v > b.v ? 1 : 0));
}

/** Build every requested facet for the filter dropdowns. */
export async function buildFilterOptions(env: AdminEnv, facetsRaw?: string | null): Promise<FilterOptions> {
  const wanted = new Set(parseFacets(facetsRaw ?? null));
  const out: FilterOptions = { countries: [], segments: [], products: [], keywords: [] };

  // Discovery: cheap GROUP BYs plus one bounded text sample for keywords.
  const [countryValues, segmentValues, combos] = await Promise.all([
    wanted.has("countries") ? distinctColumnValues(env, "country") : Promise.resolve([]),
    wanted.has("segments") ? distinctColumnValues(env, "customer_segment") : Promise.resolve([]),
    wanted.has("products") ? distinctProductCombos(env) : Promise.resolve([]),
  ]);
  const countryCandidates = mergeCaseVariants(countryValues)
    .sort((a, b) => b.n - a.n || (a.v < b.v ? -1 : 1))
    .slice(0, GROUP_LIMIT);
  const segmentCandidates = mergeCaseVariants(segmentValues)
    .sort((a, b) => b.n - a.n || (a.v < b.v ? -1 : 1))
    .slice(0, GROUP_LIMIT);
  const productCandidates = productTokens(combos)
    .sort((a, b) => b.n - a.n || (a.v < b.v ? -1 : 1))
    .slice(0, PRODUCT_LIMIT);

  let keywordTerms: string[] = [];
  if (wanted.has("keywords")) {
    const sample = await env.DB.prepare(
      `SELECT company_name, description, business_tag FROM customers
       WHERE status = 'completed' ORDER BY id DESC LIMIT ${KEYWORD_SAMPLE_ROWS}`,
    ).all<KeywordSampleRow>();
    keywordTerms = keywordCandidates(sample.results ?? []).map((candidate) => candidate.v);
  }

  // Exact counts, one bounded LIKE pass per facet.
  const requests: Array<[FacetKind, Array<{ v: string; n: number }>]> = [
    ["countries", countryCandidates],
    ["segments", segmentCandidates],
    ["products", productCandidates],
    ["keywords", keywordTerms.map((v) => ({ v, n: 0 }))],
  ];
  const counts = new Map<FacetKind, Map<string, { n: number; ne: number }>>();
  for (const [kind, candidates] of requests) {
    if (!wanted.has(kind) || !candidates.length) continue;
    counts.set(kind, await countTokens(env, kind, candidates.map((c) => c.v)));
  }

  out.countries = toOptions(countryCandidates, counts.get("countries"));
  out.segments = toOptions(segmentCandidates, counts.get("segments"));
  out.products = toOptions(productCandidates, counts.get("products"));
  out.keywords = toOptions(keywordTerms.map((v) => ({ v, n: 0 })), counts.get("keywords"));
  return out;
}
