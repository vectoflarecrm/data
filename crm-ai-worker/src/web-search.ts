// Web-search fleet, extracted from index.ts (更新.txt ① 自动寻找新客户):
// the engines are now shared by the research pipeline (index.ts) and the
// lead-discovery engine (lead-discovery.ts). Environment surface is declared
// locally (SearchEnv) so this module never imports the worker Env interface.
import { buildKeyOrder } from "./key-pool";
import { getProviderState, isProviderUsable, noteKeyUsage, keyHealthName, type ProviderKeyEntry } from "./provider-keys";
import { assertPublicHttpUrl } from "./security/outbound-url";

export interface SearchEnv {
  DB: D1Database;
  SEARLO_API_KEY?: string;
  SEARLO_API_KEY_2?: string;
}

export interface GoogleSearchResult {
  title: string;
  link: string;
  snippet: string;
}

export const FETCH_TIMEOUT_MS = 15_000;
export const MAX_SEARCH_RESULTS = 5;
// Realistic browser UA: many sites (and search engines) serve degraded pages
// or blocks to bot-style UAs, which was silently degrading research quality.
export const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Search-result URLs that add noise, not signal: marketplaces, aggregators,
// social feeds and directories drown out the company's own pages.
export const NOISE_URL_PATTERNS = [
  "pinterest.", "facebook.com/sharer", "amazon.", "ebay.", "aliexpress.",
  "etsy.", "alibaba.", "made-in-china.", "tripadvisor.", "yelp.",
  "wikipedia.", "youtube.com/watch", "instagram.com/p/", "tiktok.com/@",
  "crunchbase.com", "zoominfo.com", "apollo.io", "dnb.com", "bloomberg.com",
  "google.com/search", "tradeford.", "kompass.", "europages.", "wlw.",
];

export function isNoiseResult(url: string): boolean {
  const lower = url.toLowerCase();
  return NOISE_URL_PATTERNS.some((p) => lower.includes(p));
}

// Exported for tests: the Stage 7 guard lives here, and the SSRF suite
// asserts that refused URLs never reach the network.
export async function fetchWithTimeout(url: string, timeoutMs: number, options?: RequestInit): Promise<Response> {
  // Stage 7 SSRF guard: every dynamic outbound URL (customer domains,
  // search-result links, research/social URLs) funnels through here, so the
  // scheme/host check runs once, before any connection is made. Vendor
  // endpoints with compile-time-constant URLs also pass through harmlessly.
  // A refused URL throws OutboundUrlError; every caller already treats a
  // fetch failure as "source unavailable".
  assertPublicHttpUrl(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: { "User-Agent": BROWSER_UA, ...options?.headers },
    });
  } finally {
    clearTimeout(timer);
  }
}

interface KeyHealthRow {
  key_index: string;
  exhausted_until: string | null;
}

// Cooldown for a key that returned 429/quota-exhausted: Tavily/Exa quotas are
// monthly, so a 429 means the pool for that key is gone until the next cycle.
// A 1-day cooldown keeps the row meaningful without burning retries; Gemini
// daily quotas recover faster, so it uses a shorter cooldown.
export const SEARCH_KEY_COOLDOWN_MS = 24 * 60 * 60 * 1000;
export const GEMINI_KEY_COOLDOWN_MS = 60 * 1000;

// api_key_health rows are keyed by keyHealthName() — "<provider>:<keyId>"
// where keyId is a stable D1 row id (or env pool position). Panel edits that
// reorder/delete rows therefore never misalign cooldown state.
export async function loadExhaustedHealthKeys(env: SearchEnv, provider: string): Promise<Set<string>> {
  try {
    const result = await env.DB.prepare(
      `SELECT key_index, exhausted_until FROM api_key_health
       WHERE provider = ? AND exhausted_until IS NOT NULL AND exhausted_until > datetime('now')`,
    ).bind(provider).all<KeyHealthRow>();
    return new Set((result.results ?? []).map((r) => r.key_index));
  } catch {
    return new Set(); // table missing or transient error: assume all keys healthy
  }
}

export async function markKeyExhausted(env: SearchEnv, provider: string, healthName: string, cooldownMs: number, reason: string): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO api_key_health (provider, key_index, exhausted_until, last_error, updated_at)
       VALUES (?, ?, datetime('now', ?), ?, CURRENT_TIMESTAMP)
       ON CONFLICT (provider, key_index)
       DO UPDATE SET exhausted_until = datetime('now', ?), last_error = excluded.last_error, updated_at = CURRENT_TIMESTAMP`,
    ).bind(provider, healthName, `+${Math.round(cooldownMs / 1000)} seconds`, reason.slice(0, 200), `+${Math.round(cooldownMs / 1000)} seconds`).run();
  } catch { /* best effort */ }
}

function getSearloKeys(env: SearchEnv): string[] {
  const keys: string[] = [];
  if (env.SEARLO_API_KEY) keys.push(env.SEARLO_API_KEY);
  if (env.SEARLO_API_KEY_2) keys.push(env.SEARLO_API_KEY_2);
  return keys;
}

export async function searloSearch(query: string, env: SearchEnv): Promise<GoogleSearchResult[]> {
  // Searlo supports D1 panel config too, env secrets as fallback
  const searloState = await getProviderState(env, "searlo");
  const d1Keys = isProviderUsable(searloState) ? searloState.keys.map((k) => k.key) : [];
  const keys = d1Keys.length > 0 ? d1Keys : getSearloKeys(env);
  for (const apiKey of keys) {
    try {
      const resp = await fetchWithTimeout(
        `https://api.searlo.com/search?q=${encodeURIComponent(query)}&num=${MAX_SEARCH_RESULTS}`,
        FETCH_TIMEOUT_MS,
        { headers: { "Authorization": `Bearer ${apiKey}` } },
      );
      if (!resp.ok) continue;
      const data = await resp.json() as { results?: Array<{ title: string; url: string; snippet: string }> };
      const entry: ProviderKeyEntry = { key: apiKey, model: null, rpmLimit: null, source: "env", keyId: 0 };
      await noteKeyUsage(env, "searlo", keyHealthName("searlo", entry));
      const items = (data.results ?? []).map((item) => ({
        title: item.title, link: item.url, snippet: item.snippet,
      }));
      if (items.length > 0) return items;
    } catch { /* try next key */ }
  }
  return [];
}

// Brave Search API removed from the chain: the free tier now requires a
// payment method on file, conflicting with the zero-cost key-pool strategy.
// Tavily (primary) + Exa (volume fallback) cover the same ground; Searlo and
// keyless DuckDuckGo remain as the tail of the chain.
export async function braveSearch(query: string, env: SearchEnv, taskKeyIndex = 0): Promise<GoogleSearchResult[]> {
  const braveState = await getProviderState(env, "brave");
  const keys = isProviderUsable(braveState) ? braveState.keys : [];
  if (keys.length === 0) return [];
  const exhausted = await loadExhaustedHealthKeys(env, "brave");
  const order = buildKeyOrder(keys, keys.map((k) => keyHealthName("brave", k)), taskKeyIndex, exhausted);
  if (order.length === 0) return [];
  for (const { apiKey, healthName } of order) {
    try {
      const resp = await fetchWithTimeout(
        `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${MAX_SEARCH_RESULTS}`,
        FETCH_TIMEOUT_MS,
        {
          headers: {
            "X-Subscription-Token": apiKey,
            "Accept": "application/json",
          },
        },
      );
      if (resp.status === 429 || resp.status === 401 || resp.status === 403) {
        // Free quota is monthly: cool the key down like the other search keys
        await markKeyExhausted(env, "brave", healthName, SEARCH_KEY_COOLDOWN_MS, `HTTP ${resp.status}`);
        continue;
      }
      if (!resp.ok) continue;
      const data = await resp.json() as { web?: { results?: Array<{ title: string; url: string; description: string }> } };
      await noteKeyUsage(env, "brave", healthName); // successful call: count usage
      const items = (data.web?.results ?? [])
        .filter((item) => !isNoiseResult(item.url))
        .map((item) => ({
          title: item.title,
          link: item.url,
          snippet: item.description?.slice(0, 200) || "",
        }));
      if (items.length > 0) return items;
    } catch { /* try next key */ }
  }
  return [];
}

export async function tavilySearch(query: string, env: SearchEnv, taskKeyIndex = 0): Promise<GoogleSearchResult[]> {
  // Tavily stays the primary search fleet: D1 panel keys first, then env pool
  const tavilyState = await getProviderState(env, "tavily");
  const keys = isProviderUsable(tavilyState) ? tavilyState.keys : [];
  if (keys.length === 0) return [];
  const exhausted = await loadExhaustedHealthKeys(env, "tavily");
  const order = buildKeyOrder(keys, keys.map((k) => keyHealthName("tavily", k)), taskKeyIndex, exhausted);
  if (order.length === 0) return []; // all keys exhausted: stop calling this cycle
  // Anti-ban: the assigned key (first in order) serves the whole company task.
  // We only move to the next key when the assigned one is rejected.
  for (const { apiKey, healthName } of order) {
    try {
      const resp = await fetchWithTimeout(
        `https://api.tavily.com/search`,
        FETCH_TIMEOUT_MS,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
          body: JSON.stringify({
            query,
            max_results: MAX_SEARCH_RESULTS,
            include_answer: false,
            search_depth: "advanced", // deeper, higher-relevance results than basic
            include_raw_content: true, // page text inline: extra signal without extra fetches
          }),
        },
      );
      if (resp.status === 429 || resp.status === 401 || resp.status === 403 || resp.status === 432) {
        // Quota used up / key rejected: disable the key for the cooldown period
        // so no later task calls it again, then fall back to the next key.
        // 432 is Tavily's nonstandard "plan usage limit exceeded" — treated
        // the same as 429 (monthly quota gone until reset).
        await markKeyExhausted(env, "tavily", healthName, SEARCH_KEY_COOLDOWN_MS, `HTTP ${resp.status}`);
        continue;
      }
      if (!resp.ok) continue;
      const data = await resp.json() as { results?: Array<{ title: string; url: string; content: string; raw_content?: string | null }> };
      await noteKeyUsage(env, "tavily", healthName); // successful call: count usage (advanced = 2 credits)
      const items = (data.results ?? [])
        .filter((item) => !isNoiseResult(item.url))
        .map((item) => ({
          title: item.title,
          link: item.url,
          // Prefer Tavily's extracted raw content over the short summary
          snippet: (item.raw_content?.slice(0, 500) || item.content?.slice(0, 200) || ""),
        }));
      return items;
    } catch {
      // Network error: try the next key
    }
  }
  return [];
}

export async function exaSearch(query: string, env: SearchEnv, taskKeyIndex = 0): Promise<GoogleSearchResult[]> {
  const exaState = await getProviderState(env, "exa");
  const keys = isProviderUsable(exaState) ? exaState.keys : [];
  if (keys.length === 0) return [];
  const exhausted = await loadExhaustedHealthKeys(env, "exa");
  const order = buildKeyOrder(keys, keys.map((k) => keyHealthName("exa", k)), taskKeyIndex, exhausted);
  if (order.length === 0) return []; // all keys exhausted: stop calling this cycle
  for (const { apiKey, healthName } of order) {
    try {
      const resp = await fetchWithTimeout(
        `https://api.exa.ai/search`,
        FETCH_TIMEOUT_MS,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": apiKey },
          body: JSON.stringify({ query, numResults: MAX_SEARCH_RESULTS, type: "neural" }),
        },
      );
      if (resp.status === 429 || resp.status === 401 || resp.status === 403) {
        await markKeyExhausted(env, "exa", healthName, SEARCH_KEY_COOLDOWN_MS, `HTTP ${resp.status}`);
        continue;
      }
      if (!resp.ok) continue;
      const data = await resp.json() as { results?: Array<{ title: string; url: string; text: string }> };
      await noteKeyUsage(env, "exa", healthName); // successful call: count usage
      const items = (data.results ?? []).map((item) => ({
        title: item.title, link: item.url, snippet: item.text?.slice(0, 200) || "",
      }));
      return items;
    } catch {
      // Network error: try the next key
    }
  }
  return [];
}

export async function duckduckgoSearch(query: string): Promise<GoogleSearchResult[]> {
  try {
    const resp = await fetchWithTimeout(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
      FETCH_TIMEOUT_MS,
      { headers: { "User-Agent": "Mozilla/5.0 (compatible; CRM-ResearchBot/1.0)" } },
    );
    if (!resp.ok) return [];
    const html = await resp.text();
    const results: GoogleSearchResult[] = [];
    // Extract search results from DuckDuckGo HTML
    const resultRegex = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([^<]+)<\/a>/g;
    let match;
    while ((match = resultRegex.exec(html)) !== null && results.length < MAX_SEARCH_RESULTS) {
      results.push({
        title: match[2].replace(/<[^>]+>/g, "").trim(),
        link: match[1],
        snippet: match[3].replace(/<[^>]+>/g, "").trim(),
      });
    }
    // Fallback: simpler regex
    if (results.length === 0) {
      const simpleRegex = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
      while ((match = simpleRegex.exec(html)) !== null && results.length < MAX_SEARCH_RESULTS) {
        const title = match[2].replace(/<[^>]+>/g, "").trim();
        if (title && !title.startsWith("http")) {
          results.push({ title, link: match[1], snippet: "" });
        }
      }
    }
    return results;
  } catch {
    return [];
  }
}

/** Per-call estimated credit cost of each fleet engine, used by the
 * discovery cost report (0040): Tavily advanced search bills 2 credits per
 * call, Exa/Searlo count 1, keyless DuckDuckGo is free. Estimates only —
 * the panel reports them as 搜索积分, not real currency. */
const ENGINE_CREDITS: Record<string, number> = {
  tavily: 2,
  searlo: 1,
  exa: 1,
  duckduckgo: 0,
};

export interface SearchUsageStats {
  /** Engine that served the last winning query ("none" until one does). */
  engine: string;
  /** Cumulative estimated credit cost across all counted queries. */
  credits: number;
}

export async function multiEngineSearch(query: string, env: SearchEnv, tavilyKeyIndex = 0, stats?: SearchUsageStats): Promise<GoogleSearchResult[]> {
  // Tavily is the primary fleet (up to 60 keys); Exa is the volume fallback
  // (4x more account-efficient); Searlo and keyless DuckDuckGo close the chain.
  // Brave was removed: its free tier now requires a payment method on file.
  // `stats` (optional, 0040 discovery cost report) records the winning
  // engine and adds its estimated credit cost — absent for research callers.
  let results = await tavilySearch(query, env, tavilyKeyIndex);
  if (results.length > 0) {
    if (stats) { stats.engine = "tavily"; stats.credits += ENGINE_CREDITS.tavily; }
    return results;
  }

  results = await searloSearch(query, env);
  if (results.length > 0) {
    if (stats) { stats.engine = "searlo"; stats.credits += ENGINE_CREDITS.searlo; }
    return results;
  }

  results = await exaSearch(query, env, tavilyKeyIndex);
  if (results.length > 0) {
    if (stats) { stats.engine = "exa"; stats.credits += ENGINE_CREDITS.exa; }
    return results;
  }

  // DuckDuckGo is always available (no API key needed)
  results = await duckduckgoSearch(query);
  if (results.length > 0 && stats) {
    stats.engine = "duckduckgo";
    stats.credits += ENGINE_CREDITS.duckduckgo;
  }
  return results;
}
