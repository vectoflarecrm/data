import { handleAdminRequest } from "./admin";
import { rpmLimitFor, tryAcquireRpmSlot, rpmEnvOverride } from "./rate-limit";
import { collectKeyPool, buildKeyOrder } from "./key-pool";
import { getProviderState, isProviderUsable, noteProviderKeyError, noteProviderKeySuccess, noteKeyUsage, keyHealthName } from "./provider-keys";

interface CustomerRow {
  id: number;
  company_id: string;
  display_id: string | null;
  domain: string;
  status: string;
  company_name: string | null;
  country: string | null;
  customer_segment: string | null;
  personas_and_solutions: string | null;
  remarks: string | null;
}

interface Env {
  DB: D1Database;
  GEMINI_API_KEY: string;
  GEMINI_MODEL?: string;
  GROQ_MODEL?: string;
  CEREBRAS_MODEL?: string;
  MISTRAL_MODEL?: string;
  DEEPSEEK_MODEL?: string;
  OPENROUTER_MODEL?: string;
  ZHIPU_MODEL?: string;
  NVIDIA_MODEL?: string;
  AMD_MODEL?: string;
  // Per-key pool secrets (<PROVIDER>_API_KEY, _2 … _40) are injected onto env
  // by Cloudflare and collected at runtime via collectKeyPool(); the indexed
  // fields are intentionally NOT enumerated here (see key-pool.ts).
  // Optional total-RPM overrides (per provider, not per key). When unset the
  // limiter derives the cap from per-key free-tier defaults x key-pool size.
  GEMINI_RPM?: string;
  GROQ_RPM?: string;
  CEREBRAS_RPM?: string;
  MISTRAL_RPM?: string;
  DEEPSEEK_RPM?: string;
  ZHIPU_RPM?: string;
  NVIDIA_RPM?: string;
  OPENROUTER_RPM?: string;
  SEARLO_API_KEY?: string;
  SEARLO_API_KEY_2?: string;
  BRAVE_API_KEY?: string;
  BRAVE_API_KEY_2?: string;
  FIRECRAWL_API_KEY?: string;
  ADMIN_PANEL_TOKEN?: string;
  [key: string]: unknown;
}

interface GoogleSearchResult {
  title: string;
  link: string;
  snippet: string;
}

interface CustomerAnalysis {
  customer_segment: string;
  product_categories: string | null;
  company_size: string | null;
  geographic_coverage: string | null;
  business_type: string | null;
  product_category: string | null;
  target_market: string | null;
  personas_and_solutions: unknown;
  found_contacts: Array<{
    first_name?: string;
    last_name?: string;
    title?: string;
    email?: string;
    cellphone?: string;
    whatsapp?: string;
    linkedin_url?: string;
    source?: string;
  }>;
  remarks: string;
}

const BATCH_SIZE = 1;
const FETCH_TIMEOUT_MS = 15_000;
const AI_TIMEOUT_MS = 60_000;
const MAX_SOURCE_PAGES = 5;
const MAX_SEARCH_RESULTS = 5;
const INTER_SOURCE_DELAY_MS = 2_000;
// Realistic browser UA: many sites (and search engines) serve degraded pages
// or blocks to bot-style UAs, which was silently degrading research quality.
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const SEARCH_QUERIES = [
  (name: string, country: string) => `"${name}" ${country} water sports company email phone contact`,
  (name: string) => `"${name}" email whatsapp cellphone contact person`,
  (name: string) => `site:linkedin.com/company "${name}"`,
  (name: string) => `site:linkedin.com/in "${name}" CEO owner manager`,
  (name: string) => `site:linkedin.com "${name}" purchasing buyer manager`,
  (name: string) => `"${name}" about products services inflatable boat SUP`,
];
// Search-result URLs that add noise, not signal: marketplaces, aggregators,
// social feeds and directories drown out the company's own pages.
const NOISE_URL_PATTERNS = [
  "pinterest.", "facebook.com/sharer", "amazon.", "ebay.", "aliexpress.",
  "etsy.", "alibaba.", "made-in-china.", "tripadvisor.", "yelp.",
  "wikipedia.", "youtube.com/watch", "instagram.com/p/", "tiktok.com/@",
  "crunchbase.com", "zoominfo.com", "apollo.io", "dnb.com", "bloomberg.com",
  "google.com/search", "tradeford.", "kompass.", "europages.", "wlw.",
];

function isNoiseResult(url: string): boolean {
  const lower = url.toLowerCase();
  return NOISE_URL_PATTERNS.some((p) => lower.includes(p));
}

function isOwnDomain(url: string, domain: string | undefined): boolean {
  if (!domain) return false;
  try {
    const resultHost = new URL(url).hostname.replace(/^www\./, "");
    const ownHost = new URL(normalizeDomain(domain)).hostname.replace(/^www\./, "");
    return resultHost === ownHost || resultHost.endsWith(`.${ownHost}`) || ownHost.endsWith(`.${resultHost}`);
  } catch {
    return false;
  }
}

// Direct contact extraction from raw page text: complement AI analysis with
// verbatim evidence so the model has anchored candidates, not just prose.
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_REGEX = /(?:(?:\+\d{1,3}[\s.-]?)?(?:\(\d{1,4}\)[\s.-]?)?\d{2,4}[\s.-]?\d{2,4}[\s.-]?\d{2,4})/g;

function extractContactEvidence(text: string): { emails: string[]; phones: string[] } {
  const emails = [...new Set((text.match(EMAIL_REGEX) ?? []).map((e) => e.toLowerCase()))]
    .filter((e) => !e.endsWith(".png") && !e.endsWith(".jpg") && !e.includes("example.") && !e.includes("sentry") && e.length < 80)
    .slice(0, 8);
  const phones = [...new Set((text.match(PHONE_REGEX) ?? []).map((p) => p.trim()))]
    .filter((p) => {
      const digits = p.replace(/\D/g, "");
      // Reject junk like repeated/sequential digit runs and pure-zero strings:
      // 905-907-908 style sequences and copyright dates were common false hits.
      if (digits.length < 8 || digits.length > 15) return false;
      if (/^(\d)\1+$/.test(digits)) return false; // all same digit
      if (/(?:0123456789|12345678|87654321|98765432)/.test(digits)) return false; // sequential
      if (/^0+$/.test(digits)) return false;
      if (/^20\d{2}[-\s.]?20\d{2}$/.test(p.trim())) return false; // copyright year pairs
      // Junk detector: 905-907-908 style serials contain two near-identical
      // halves (edit distance 1) or two ascending-delta runs. Real numbers
      // rarely satisfy either.
      const half = Math.floor(digits.length / 2);
      let diff = 0;
      for (let i = 0; i < half; i++) if (digits[i] !== digits[half + i]) diff++;
      if (half >= 3 && diff <= 1) return false; // halves nearly identical
      const group = digits.match(/\d{3}/g);
      if (group && group.length >= 3) {
        // Cross-group step (e.g. 111|222|333: each +1; 905|906|907: each +1)
        const steps = group.slice(1).map((g, i) => g.charCodeAt(0) - group[i].charCodeAt(0));
        const uniform = new Set(steps).size === 1 && Math.abs(steps[0]) <= 2;
        if (uniform) return false;
      }
      const unique = new Set(digits).size;
      if (unique <= 2 && digits.length >= 8) return false; // too few distinct digits
      return true;
    })
    .slice(0, 8);
  return { emails, phones };
}
// 2026-09: the gemini-2.5 family is no longer available to new Google
// accounts (chat call returns 404). Official current endpoints per AI Studio:
// gemini-3.5-flash-lite only (30 RPM/key, high TPM — bulk extraction primary).
// gemini-3.8-flash was dropped: live tests showed 503 high-demand on most keys
// while lite answered instantly — lite is sufficient for crawl/extract tasks.
// working on legacy AIzaSy… and new AQ.Ab8… key formats.
const DEFAULT_MODEL = "gemini-3.5-flash-lite";
// Stay on lite-class models: 3.5-flash-lite is sufficient for the extraction
// workload and 3.8-flash is intentionally NOT in the chain (higher cost/
// latency; only reachable if explicitly set via GEMINI_MODEL or per-key model).
const FALLBACK_MODELS = ["gemini-3.1-flash-lite", "gemini-3.6-flash", "gemini-flash-latest"];
const STALE_PROCESSING_MINUTES = 30;
const RETRYABLE_WEBSITE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const AI_RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const INTER_CUSTOMER_DELAY_MS = 5_000;
const RATE_LIMIT_BASE_DELAY_MS = 30_000;
const MAX_RETRIES = 3;
const COMPANY_MARKER = (companyId: string) => `【合并数据公司ID: ${companyId}】`;

function withCompanyMarker(remarks: string | null | undefined, companyId: string): string {
  const marker = COMPANY_MARKER(companyId);
  const base = (remarks ?? "").trimEnd();
  return base.endsWith(marker) ? base : `${base}${base ? "\n" : ""}${marker}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRetryCount(remarks: string | null | undefined): number {
  if (!remarks) return 0;
  const match = remarks.match(/\[retry:(\d+)\]/);
  return match ? parseInt(match[1], 10) : 0;
}

function stripRetryTag(remarks: string): string {
  return remarks.replace(/\n?\[retry:\d+\]/g, "").trimEnd();
}

function normalizeDomain(value: string): string {
  const candidate = value.trim();
  if (!candidate) throw new Error("domain is empty");
  const url = new URL(/^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("domain must use HTTP or HTTPS");
  }
  return url.toString();
}

async function fetchWithTimeout(url: string, timeoutMs: number, options?: RequestInit): Promise<Response> {
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

async function fetchWebsite(url: string): Promise<Response> {
  let response = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);
  if (!RETRYABLE_WEBSITE_STATUSES.has(response.status)) return response;
  await new Promise((resolve) => setTimeout(resolve, 250));
  response = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);
  return response;
}

function websiteError(response: Response): Error {
  const detail = response.status === 526
    ? " (origin SSL certificate invalid)"
    : response.status === 530
      ? " (origin/DNS unavailable)"
      : "";
  return new Error(`website HTTP ${response.status}${detail}`);
}

// Statuses that usually mean a bot-block/JS-rendered page (Cloudflare challenge,
// WAF, etc.) rather than a genuinely broken site — worth one Firecrawl retry.
const BLOCKED_WEBSITE_STATUSES = new Set([403, 503]);

/**
 * Firecrawl fallback (环节1 降级回退): when the direct fetch is bot-blocked or
 * the page needs JS rendering, Firecrawl's headless renderer returns clean
 * LLM-oriented markdown. Optional — the pipeline works without it; with it,
 * hard-blocked sites become analyzable instead of failed.
 */
async function firecrawlScrape(url: string, env: Env): Promise<string> {
  if (!env.FIRECRAWL_API_KEY) return "";
  try {
    const resp = await fetchWithTimeout("https://api.firecrawl.dev/v1/scrape", FETCH_TIMEOUT_MS, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.FIRECRAWL_API_KEY}`,
      },
      body: JSON.stringify({ url, formats: ["markdown"], waitFor: 3_000 }),
    });
    if (!resp.ok) return "";
    const data = await resp.json() as { data?: { markdown?: string } };
    return data.data?.markdown ?? "";
  } catch {
    return ""; // Firecrawl is best-effort: never block the pipeline on it
  }
}

async function extractPageText(response: Response): Promise<string> {
  const parts: string[] = [];
  const addText = (text: string) => {
    const clean = text.replace(/\s+/g, " ").trim();
    if (clean) parts.push(clean);
  };

  const rewriter = new HTMLRewriter()
    .on("title", { text(text) { addText(text.text); } })
    .on("meta", {
      element(element) {
        const name = (element.getAttribute("name") ?? "").toLowerCase();
        const prop = (element.getAttribute("property") ?? "").toLowerCase();
        if (name === "description" || prop === "og:description") {
          addText(element.getAttribute("content") ?? "");
        }
        if (name === "keywords") {
          addText("关键词: " + (element.getAttribute("content") ?? ""));
        }
      },
    })
    .on("p", { text(text) { addText(text.text); } })
    .on("h1", { text(text) { addText("[标题] " + text.text); } })
    .on("h2", { text(text) { addText("[小标题] " + text.text); } })
    .on("li", { text(text) { addText("• " + text.text); } })
    // Contact details often live ONLY in link hrefs (mailto:/tel:), which the
    // text-element handlers above never see. Surface them as text so the
    // contact-evidence extraction and the AI can pick them up.
    .on("a", {
      element(element) {
        const href = element.getAttribute("href") ?? "";
        if (href.toLowerCase().startsWith("mailto:")) {
          addText("[邮箱链接] " + href.slice(7).split("?")[0]);
        } else if (href.toLowerCase().startsWith("tel:")) {
          addText("[电话链接] " + href.slice(4));
        }
      },
    });

  await rewriter.transform(response).arrayBuffer();
  return parts.join("\n").slice(0, 15_000);
}

interface SocialMediaLink {
  platform: string;
  url: string;
  verified: boolean;
}

const SOCIAL_PLATFORMS: Array<{ name: string; patterns: string[] }> = [
  { name: "LinkedIn", patterns: ["linkedin.com/company/", "linkedin.com/in/"] },
  { name: "Facebook", patterns: ["facebook.com/", "fb.com/"] },
  { name: "Instagram", patterns: ["instagram.com/"] },
  { name: "Twitter", patterns: ["twitter.com/", "x.com/"] },
  { name: "YouTube", patterns: ["youtube.com/", "youtu.be/"] },
  { name: "TikTok", patterns: ["tiktok.com/@"] },
];

function detectPlatform(url: string): string | null {
  for (const platform of SOCIAL_PLATFORMS) {
    for (const pattern of platform.patterns) {
      if (url.includes(pattern)) return platform.name;
    }
  }
  return null;
}

async function extractLinks(response: Response): Promise<string[]> {
  const links: string[] = [];
  const rewriter = new HTMLRewriter()
    .on("a", {
      element(element) {
        const href = element.getAttribute("href") ?? "";
        if (href && detectPlatform(href)) {
          try {
            const url = new URL(href, response.url);
            links.push(url.toString());
          } catch { /* ignore invalid URLs */ }
        }
      },
    });
  try {
    await rewriter.transform(response.clone()).arrayBuffer();
  } catch { /* ignore */ }
  return [...new Set(links)].slice(0, MAX_SOURCE_PAGES);
}

async function verifySocialMedia(links: string[]): Promise<SocialMediaLink[]> {
  const verified: SocialMediaLink[] = [];
  const seen = new Set<string>();
  for (const link of links) {
    const platform = detectPlatform(link);
    if (!platform) continue;
    const key = `${platform}:${link}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const resp = await fetchWithTimeout(link, FETCH_TIMEOUT_MS, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; CRM-ResearchBot/1.0)" },
      });
      verified.push({
        platform,
        url: link,
        verified: resp.ok,
      });
      await sleep(INTER_SOURCE_DELAY_MS);
    } catch {
      verified.push({ platform, url: link, verified: false });
    }
  }
  return verified;
}


interface KeyHealthRow {
  key_index: string;
  exhausted_until: string | null;
}

// Cooldown for a key that returned 429/quota-exhausted: Tavily/Exa quotas are
// monthly, so a 429 means the pool for that key is gone until the next cycle.
// A 1-day cooldown keeps the row meaningful without burning retries; Gemini
// daily quotas recover faster, so it uses a shorter cooldown.
const SEARCH_KEY_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const GEMINI_KEY_COOLDOWN_MS = 60 * 1000;

// api_key_health rows are keyed by keyHealthName() — "<provider>:<keyId>"
// where keyId is a stable D1 row id (or env pool position). Panel edits that
// reorder/delete rows therefore never misalign cooldown state.
async function loadExhaustedHealthKeys(env: Env, provider: string): Promise<Set<string>> {
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

async function markKeyExhausted(env: Env, provider: string, healthName: string, cooldownMs: number, reason: string): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO api_key_health (provider, key_index, exhausted_until, last_error, updated_at)
       VALUES (?, ?, datetime('now', ?), ?, CURRENT_TIMESTAMP)
       ON CONFLICT (provider, key_index)
       DO UPDATE SET exhausted_until = datetime('now', ?), last_error = excluded.last_error, updated_at = CURRENT_TIMESTAMP`,
    ).bind(provider, healthName, `+${Math.round(cooldownMs / 1000)} seconds`, reason.slice(0, 200), `+${Math.round(cooldownMs / 1000)} seconds`).run();
  } catch { /* best effort */ }
}

function getSearloKeys(env: Env): string[] {
  const keys: string[] = [];
  if (env.SEARLO_API_KEY) keys.push(env.SEARLO_API_KEY);
  if (env.SEARLO_API_KEY_2) keys.push(env.SEARLO_API_KEY_2);
  return keys;
}

async function searloSearch(query: string, env: Env): Promise<GoogleSearchResult[]> {
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
      await noteKeyUsage(env, "searlo", keyHealthName("searlo", { key: apiKey, model: null, rpmLimit: null, source: "env", keyId: 0 }));
      const items = (data.results ?? []).map((item) => ({
        title: item.title, link: item.url, snippet: item.snippet,
      }));
      if (items.length > 0) return items;
    } catch { /* try next key */ }
  }
  return [];
}

function getBraveKeys(env: Env): string[] {
  const keys: string[] = [];
  if (env.BRAVE_API_KEY) keys.push(env.BRAVE_API_KEY);
  if (env.BRAVE_API_KEY_2) keys.push(env.BRAVE_API_KEY_2);
  return keys;
}

// Brave Search API (free tier ~2,000 queries/month, no credit card):
// independent web index, good at surfacing official homepages and LinkedIn
// pages for company-name queries.
async function braveSearch(query: string, env: Env, taskKeyIndex = 0): Promise<GoogleSearchResult[]> {
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

async function tavilySearch(query: string, env: Env, taskKeyIndex = 0): Promise<GoogleSearchResult[]> {
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

async function exaSearch(query: string, env: Env, taskKeyIndex = 0): Promise<GoogleSearchResult[]> {
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

async function duckduckgoSearch(query: string): Promise<GoogleSearchResult[]> {
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

async function multiEngineSearch(query: string, env: Env, tavilyKeyIndex = 0): Promise<GoogleSearchResult[]> {
  // Tavily is the primary fleet (up to 60 keys); other engines are fallbacks
  let results = await tavilySearch(query, env, tavilyKeyIndex);
  if (results.length > 0) return results;

  results = await braveSearch(query, env, tavilyKeyIndex);
  if (results.length > 0) return results;

  results = await searloSearch(query, env);
  if (results.length > 0) return results;

  results = await exaSearch(query, env, tavilyKeyIndex);
  if (results.length > 0) return results;

  // DuckDuckGo is always available (no API key needed)
  results = await duckduckgoSearch(query);
  return results;
}

async function searchCompanyInfo(companyName: string, country: string, env: Env, tavilyKeyIndex = 0, customerDomain?: string): Promise<string> {
  const allResults: GoogleSearchResult[] = [];
  const seenUrls = new Set<string>();

  for (const queryFn of SEARCH_QUERIES) {
    const query = queryFn(companyName, country);
    const results = await multiEngineSearch(query, env, tavilyKeyIndex);
    for (const r of results) {
      if (isNoiseResult(r.link) || isOwnDomain(r.link, customerDomain)) continue;
      if (!seenUrls.has(r.link)) {
        seenUrls.add(r.link);
        allResults.push(r);
      }
    }
    await sleep(INTER_SOURCE_DELAY_MS);
  }

  if (allResults.length === 0) return "";

  // Fetch content from top search results. LinkedIn pages carry the richest
  // contact/role signal, so they are prioritised; own-domain results are
  // skipped (the main site is already fetched separately).
  const prioritised = [...allResults]
    .filter((r) => !isOwnDomain(r.link, customerDomain))
    .sort((a, b) => Number(b.link.includes("linkedin.com")) - Number(a.link.includes("linkedin.com")));
  const pages: string[] = [];
  for (const result of prioritised.slice(0, MAX_SOURCE_PAGES)) {
    try {
      const resp = await fetchWithTimeout(result.link, FETCH_TIMEOUT_MS);
      if (resp.ok) {
        const text = await extractPageText(resp);
        if (text.length > 100) {
          // Give LinkedIn pages more room (role/title lists are long)
          const budget = result.link.includes("linkedin.com") ? 6_000 : 4_000;
          const contact = extractContactEvidence(text);
          const contactLine = contact.emails.length || contact.phones.length
            ? `\n[直接提取] 邮箱: ${contact.emails.join(", ") || "无"} | 电话: ${contact.phones.join(", ") || "无"}`
            : "";
          pages.push(`\n=== 搜索结果: ${result.title} ===\nURL: ${result.link}\n摘要: ${result.snippet.slice(0, 300)}\n内容: ${text.slice(0, budget)}${contactLine}`);
        }
      }
      await sleep(INTER_SOURCE_DELAY_MS);
    } catch { /* skip failed pages */ }
  }

  // Snippets already contain Tavily raw-content extracts, so they remain a
  // useful fallback even when full page fetches fail. Contact evidence is
  // also mined from snippet text, since LinkedIn/business directories often
  // show emails in snippets even when the page itself is paywalled.
  if (pages.length === 0) {
    const snippetText = allResults.map((r) => `${r.snippet}`).join("\n");
    const contact = extractContactEvidence(snippetText);
    const contactLine = contact.emails.length || contact.phones.length
      ? `\n[直接提取] 邮箱: ${contact.emails.join(", ") || "无"} | 电话: ${contact.phones.join(", ") || "无"}`
      : "";
    return `\n\n--- 搜索结果摘要 (${allResults.length}条) ---\n${allResults.map((r) => `${r.title}: ${r.snippet}`).join("\n")}${contactLine}`;
  }
  return `\n\n--- 搜索结果页面 (${allResults.length}条) ---\n${pages.join("\n")}`;
}

async function fetchAdditionalSources(companyName: string, domain: string, env: Env): Promise<string> {
  const sources: string[] = [];
  const sourceLabels: string[] = [];

  // 1. Try fetching About/Contact/Team pages from the same domain
  const subPages = ["/about", "/about-us", "/contact", "/team", "/company", "/products", "/services"];
  for (const path of subPages) {
    if (sources.length >= 3) break;
    try {
      const url = normalizeDomain(domain.replace(/\/$/, "") + path);
      const resp = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);
      if (resp.ok) {
        const text = await extractPageText(resp);
        if (text.length > 100) {
          sources.push(`\n=== ${path} 页面内容 ===\n${text.slice(0, 3_000)}`);
          sourceLabels.push(path);
        }
      }
      await sleep(INTER_SOURCE_DELAY_MS);
    } catch { /* skip failed sub-pages */ }
  }

  // 2. Try fetching social media links found on the main website
  try {
    const mainResp = await fetchWithTimeout(normalizeDomain(domain), FETCH_TIMEOUT_MS);
    if (mainResp.ok) {
      const socialLinks = await extractLinks(mainResp);
      for (const link of socialLinks.slice(0, 3)) {
        try {
          const resp = await fetchWithTimeout(link, FETCH_TIMEOUT_MS);
          if (resp.ok) {
            const text = await extractPageText(resp);
            if (text.length > 100) {
              const platform = link.includes("linkedin") ? "LinkedIn" : link.includes("facebook") ? "Facebook" : link.includes("instagram") ? "Instagram" : "社交媒体";
              sources.push(`\n=== ${platform} 页面内容 ===\n${text.slice(0, 3_000)}`);
              sourceLabels.push(platform);
            }
          }
          await sleep(INTER_SOURCE_DELAY_MS);
        } catch { /* skip failed social pages */ }
      }
    }
  } catch { /* skip if main site fails */ }

  return sources.length > 0
    ? `\n\n--- 额外信息来源 (${sourceLabels.join(", ")}) ---\n${sources.join("\n")}`
    : "";
}

function parseAnalysis(content: string): CustomerAnalysis {
  const trimmed = content.trim();
  if (trimmed.startsWith("```") || trimmed.endsWith("```")) {
    throw new Error("AI response was not pure JSON");
  }
  const parsed: unknown = JSON.parse(trimmed);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("AI response must be a JSON object");
  }
  const object = parsed as Record<string, unknown>;
  if (typeof object.customer_segment !== "string" || !object.customer_segment.trim()) {
    throw new Error("AI response has no valid customer_segment");
  }
  if (typeof object.remarks !== "string") {
    throw new Error("AI response has no valid remarks");
  }
  if (!("personas_and_solutions" in object)) {
    throw new Error("AI response has no personas_and_solutions");
  }
  // Sanitize a single contact field value: keep pure data, move prose elsewhere.
  const cleanField = (value: unknown): string | undefined => {
    if (typeof value !== "string") return undefined;
    const v = value.trim();
    if (!v) return undefined;
    // Reject values that are prose/placeholders rather than data (e.g. phones
    // annotated with sources, or "信息不足，需进一步验证" stuffed into fields).
    if (/[。，]/.test(v) && !/^[+\d][\d\s().-]+$/.test(v)) return undefined;
    if (v.includes("信息不足") || v.includes("需进一步验证") || v.includes("来源：") || v.includes("Source:")) return undefined;
    return v;
  };
  const cleanEmail = (value: unknown): string | undefined => {
    const v = cleanField(value);
    // Must look like a full email address, not a domain or a note.
    return v && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) ? v.toLowerCase() : undefined;
  };
  const cleanPhone = (value: unknown): string | undefined => {
    const v = cleanField(value);
    if (!v) return undefined;
    // Normalize "ext." extensions and keep only plausible phone characters.
    const compact = v.replace(/ext\.?\s*\d+$/i, "").trim();
    return /^[+\d][\d\s()./-]{6,}$/.test(compact) ? compact : undefined;
  };
  const cleanUrl = (value: unknown): string | undefined => {
    const v = cleanField(value);
    return v && /^https?:\/\//i.test(v) ? v : undefined;
  };
  const foundContacts = Array.isArray(object.found_contacts)
    ? (object.found_contacts as Array<Record<string, unknown>>)
        .filter((c) => c && typeof c === "object")
        .map((c) => ({
          first_name: cleanField(c.first_name),
          last_name: cleanField(c.last_name),
          title: cleanField(c.title),
          email: cleanEmail(c.email),
          cellphone: cleanPhone(c.cellphone),
          whatsapp: cleanPhone(c.whatsapp),
          linkedin_url: cleanUrl(c.linkedin_url),
          source: cleanField(c.source),
        }))
        // Hard entry bar: a contact must carry a real name, or a valid
        // email, or a valid phone — otherwise drop it entirely.
        .filter((c) => c.first_name || c.last_name || c.email || c.cellphone || c.whatsapp)
    : [];
  return {
    customer_segment: object.customer_segment.trim(),
    product_categories: typeof object.product_categories === "string" ? object.product_categories.trim() : null,
    company_size: typeof object.company_size === "string" ? object.company_size.trim() : null,
    geographic_coverage: typeof object.geographic_coverage === "string" ? object.geographic_coverage.trim() : null,
    business_type: typeof object.business_type === "string" ? object.business_type.trim() : null,
    product_category: typeof object.product_category === "string" ? object.product_category.trim() : null,
    target_market: typeof object.target_market === "string" ? object.target_market.trim() : null,
    personas_and_solutions: object.personas_and_solutions,
    found_contacts: foundContacts,
    remarks: object.remarks.trim(),
  };
}

const AI_SYSTEM_PROMPT = `你是一名高级B2B市场数据分析师和营销专家，专注于水上运动行业（inflatable boats, RIB boats, SUPs, kayaks, yachts, kitesurfing, windsurfing等）。

你的核心原则：
1. 数据真实性高于一切——宁可留空，绝不编造
2. 只根据提供的多源信息作答，不得编造任何事实
3. 如果信息不足，明确标注"信息不足，需进一步验证"
4. 必须只返回一个合法JSON对象，禁止Markdown、代码围栏和额外说明
5. 严禁根据姓名猜测邮箱格式（如禁止从 John Doe 生成 john.doe@company.com）
6. 严禁编造手机号码、WhatsApp号码或任何联系方式

核心任务一——联系方式挖掘（最高优先级）：
- 从网页、搜索结果中提取真实的email地址
- 从网页、搜索结果中提取真实的手机号码（Cellphone/Mobile）
- 只有在官网包含 wa.me 链接、WhatsApp图标或社媒明确标注时才填写WhatsApp
- 所有联系方式必须有明确来源，不得猜测或编造

核心任务二——LinkedIn联系人挖掘（特别重要）：
- 从搜索结果中的LinkedIn页面提取公司员工信息
- 重点查找以下职位的人员：CEO、Owner、Founder、Director、Manager、Purchasing、Buyer、Sales
- 记录每个人的：姓名（First Name + Last Name）、职位（Title）、LinkedIn URL
- 如果LinkedIn页面包含邮箱或电话，也一并记录
- 只记录在搜索结果中明确出现的人名，不得猜测
- LinkedIn URL必须是真实的搜索结果链接

核心任务三——社交媒体验证：
- 从数据中找到的所有社交媒体链接已通过"已验证社交媒体"部分提供
- 只使用已验证的社交媒体链接，不得自行猜测或编造社媒地址
- 记录每个社交媒体平台的账号名称和URL

核心任务四——个性化开发信要点提炼：
- 基于公司的全文字信息（产品、服务、新闻、博客、社媒内容），总结可用于个性化开发信的要点（推荐引用的具体产品、活动、市场定位），写入 remarks
- 语言风格专业但亲切，适合B2B水上运动行业

联系人入库标准（硬性要求）：
- 每条联系人必须至少包含：真实姓名（名+姓），或 真实邮箱，或 真实电话号码——三者至少其一
- 完全没有任何姓名和联系方式的条目禁止输出（宁缺毋滥）
- whatsapp 字段只填纯号码（如 +34600123456），禁止附加解释文字、来源说明或括号注释；来源信息一律写入 source 字段
- 数值字段（email/cellphone/whatsapp/linkedin_url）只放数据本身，说明性文字写入 source
- email 必须是页面上逐字出现的完整地址；只有域名（如 @company.com）而无完整地址时，email 留空并在 source 中记录该域名
- 「信息不足，需进一步验证」这类文字禁止写入任何联系方式字段，只能写入 remarks
- 找到多个联系邮箱时，优先选择销售/采购/商务类邮箱（sales@、info@、purchasing@、export@、contact@ 等），其次才是技术/法务类邮箱
- 若某字段在来源页面中未提及，一律置为 null，严禁臆测或从上下文推断

分析要求：
- 充分利用公司的所有文字信息（产品描述、公司介绍、新闻、博客、社媒帖子等）
- 交叉验证多个信息来源，确保数据准确
- 使用标准分类体系：
  * 客户细分：Distributor/Dealer/Manufacturer/User/OEM/Service Provider/E-commerce/不相关
  * 产品类别：Inflatable Boats/Paddle Boards/Kayaks/Yachts/Kitesurfing/Windsurfing/Accessories/Apparel
  * 公司规模：Small(1-10)/Medium(11-50)/Large(51-200)/Enterprise(200+)
  * 地理覆盖：Local/National/International
- 识别公司的核心业务模式和行业定位
- 识别关键决策者和采购负责人（姓名、职位、联系方式）
- 评估其作为潜在客户的价值`;

function buildUserPrompt(customer: CustomerRow, researchContext: string): string {
  return `请深度分析以下企业信息，交叉验证多个来源的数据，提供详细的客户画像。

## 基本信息
- 公司识别码：${customer.company_id}
- 企业网址：${customer.domain}

## 多源研究数据
${researchContext || "（未获取到有效信息）"}

## 分析要求

### 第一优先级：联系方式和LinkedIn联系人挖掘
请从上述数据中仔细提取以下信息，每条都必须有明确来源：

#### 联系方式
- Email地址：从网页、联系页面、搜索结果中找到的真实邮箱
- 手机号码（Cellphone/Mobile）：从网页、社媒中找到的真实手机号
- WhatsApp：仅当官网有wa.me链接或社媒明确标注时才填写

#### LinkedIn联系人（特别重要）
搜索结果中包含LinkedIn页面，请仔细提取每个LinkedIn页面上出现的公司员工：
- 人名（First Name + Last Name）：在搜索结果摘要或标题中明确出现的姓名
- 职位（Title）：CEO、Owner、Founder、Director、Manager、Purchasing、Buyer、Sales等
- LinkedIn URL：搜索结果中真实的LinkedIn链接
- 联系方式：如果页面包含邮箱或电话

请尽可能多地找到LinkedIn上的公司员工，特别是：
- 公司创始人和高管（CEO、Owner、Founder、Director）
- 采购和销售负责人（Purchasing、Buyer、Sales Manager、Export）
- 产品和市场负责人（Product Manager、Marketing Manager）
- 运营负责人（Operations、General Manager）

### 第二优先级：业务分析
1. 客户细分（Customer Segment）：使用以下标准分类：
   - Distributor（批发/分销商）：主营批发、分销inflatable boat, RIB boat, SUP, paddle board, kayak, Yacht
   - Dealer（多品牌零售商）：多品牌零售inflatable boat, SUP, paddle board, kayak, Yacht，提供维修服务
   - Manufacturer（制造商）：自主生产inflatable boat, RIB boat, SUP, paddle board, kayak, Yacht产品
   - User（终端用户）：租赁或使用inflatable boat, SUP, paddle board, kayak, Yacht，开设水上运动课程培训
   - OEM（代工厂）：为其他品牌代工生产水上运动产品
   - Service Provider（服务提供商）：提供水上运动相关服务（培训、维修、租赁等）
   - E-commerce（电商）：在线销售水上运动产品
   - 不相关：该公司不销售、使用inflatable boat, RIB boat, SUP, paddle board, kayak, Yacht产品

2. 产品类别细分（Product Categories）：
   - Inflatable Boats（充气船）：RIB boats, inflatable dinghy, inflatable tender
   - Paddle Boards（桨板）：SUP, standup paddle board, inflatable SUP
   - Kayaks（皮划艇）：inflatable kayak, hard shell kayak, sit-on-top kayak
   - Yachts（游艇）：motor yacht, sailing yacht, luxury yacht
   - Kitesurfing Equipment（风筝冲浪装备）：kite, board, harness, wetsuit
   - Windsurfing Equipment（帆板装备）：sail, board, rig
   - Accessories（配件）：paddle, pump, fin, repair kit, life jacket
   - Water Sports Apparel（水上运动服装）：wetsuit, rash guard, swimwear

3. 公司规模（Company Size）：
   - Small（小型）：1-10人
   - Medium（中型）：11-50人
   - Large（大型）：51-200人
   - Enterprise（企业级）：200+人

4. 地理覆盖（Geographic Coverage）：
   - Local（本地）：仅在本国/本地区经营
   - National（全国）：在多个国家经营
   - International（国际）：在全球多个国家经营

5. 客户画像：识别2-5个关键角色（如采购经理、产品总监、创始人等），分析每个角色的需求和痛点
6. 解决方案：针对每个角色，提供具体的解决方案建议
7. 备注：总结公司的关键信息、潜在合作机会和风险点
8. 信息来源标注：注明分析结论来自哪个信息来源

### 重要提醒
- 严禁编造任何联系方式！如果找不到就留空
- 严禁根据姓名猜测邮箱格式
- 每个找到的联系方式必须注明来源URL或页面`;
}

interface OpenAIResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

async function openaiCompatibleAnalyze(
  apiUrl: string,
  apiKey: string,
  model: string,
  customer: CustomerRow,
  researchContext: string,
  controller: AbortController,
  // Public free endpoints (e.g. AMD Radeon Cloud) run vLLM/SGLang-style
  // backends where response_format json_object is unreliable or rejected —
  // jsonMode=false omits it and relies on the prompt hint + parseAnalysis.
  jsonMode = true,
): Promise<CustomerAnalysis> {
  const jsonFormatHint = `\n\n你必须返回一个合法的JSON对象，格式如下：\n{\n  "customer_segment": "客户细分（Distributor/Dealer/Manufacturer/User/OEM/Service Provider/E-commerce/不相关）",\n  "product_categories": "产品类别（Inflatable Boats/Paddle Boards/Kayaks/Yachts/Kitesurfing/Windsurfing/Accessories/Apparel）",\n  "company_size": "公司规模（Small/Medium/Large/Enterprise）",\n  "geographic_coverage": "地理覆盖（Local/National/International）",\n  "personas_and_solutions": {"personas": [{"name": "角色名", "role": "职位", "needs": ["需求1"], "pain_points": ["痛点1"]}], "solutions": [{"name": "方案名", "value": "方案描述", "target_persona": "目标角色"}]},\n  "found_contacts": [{"first_name": "名", "last_name": "姓", "title": "职位", "email": "真实邮箱", "cellphone": "真实手机号", "whatsapp": "仅当有wa.me链接时填写", "linkedin_url": "LinkedIn链接", "source": "信息来源URL"}],\n  "remarks": "备注"\n}\n\n重要：found_contacts中的所有联系方式必须是从提供的数据中真实找到的，严禁编造！`;

  const response = await fetch(apiUrl, {
    method: "POST",
    signal: controller.signal,
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: AI_SYSTEM_PROMPT },
        { role: "user", content: buildUserPrompt(customer, researchContext) + jsonFormatHint },
      ],
      temperature: 0.1,
      ...(jsonMode ? { response_format: { type: "json_object" as const } } : {}),
    }),
  });
  if (!response.ok) {
    const errBody = (await response.text()).replace(/\s+/g, " ").trim().slice(0, 200);
    throw new Error(`HTTP ${response.status}${errBody ? `: ${errBody}` : ""}`);
  }
  const data: OpenAIResponse = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("AI response has no text content");
  return parseAnalysis(content);
}

async function analyzeWithGemini(
  customer: CustomerRow,
  researchContext: string,
  env: Env,
  controller: AbortController,
): Promise<CustomerAnalysis | null> {
  // D1-first key resolution (方案B): panel-managed api_configs rows take
  // priority; env secrets remain as bootstrap fallback.
  const state = await getProviderState(env, "gemini");
  if (!isProviderUsable(state)) return null;
  const pool = state.keys;
  const exhausted = await loadExhaustedHealthKeys(env, "gemini");
  // One fixed Gemini key per company task (index derived from customer.id):
  // all models tried on the same key first; only a rejected/exhausted key
  // rotates to the next key.
  const order = buildKeyOrder(pool, pool.map((p) => keyHealthName("gemini", p)), customer.id, exhausted)
    .map((attempt) => pool.find((p) => keyHealthName("gemini", p) === attempt.healthName)!)
    .map((entry) => ({ entry, healthName: keyHealthName("gemini", entry) }));
  if (order.length === 0) {
    // All keys are in cooldown (e.g. HTTP 429 rate limit). This is transient —
    // surface it as a retryable condition instead of silently falling through
    // to the (unconfigured) fallback providers.
    throw new Error("HTTP 429: all Gemini keys are cooling down (rate limited)");
  }
  const geminiRpmLimit = state.rpmTotal ?? rpmLimitFor("gemini", pool.length, rpmEnvOverride(env, "gemini"));
  for (const { entry, healthName } of order) {
    const key = entry.key;
    const model = entry.model || env.GEMINI_MODEL || DEFAULT_MODEL;
    const models = [model, ...FALLBACK_MODELS].filter(
      (m, i, all) => all.indexOf(m) === i,
    );
    for (const m of models) {
      // Proactive RPM guard: once this minute's cap is consumed, hand over to
      // the fallback chain instead of hard-hitting the upstream free tier.
      if (!tryAcquireRpmSlot("gemini", geminiRpmLimit)) return null;
      try {
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent`,
          {
            method: "POST",
            signal: controller.signal,
            headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: AI_SYSTEM_PROMPT }] },
              contents: [{ role: "user", parts: [{ text: buildUserPrompt(customer, researchContext) }] }],
              generationConfig: {
                temperature: 0.1,
                responseMimeType: "application/json",
                responseSchema: {
                  type: "OBJECT",
                  properties: {
                    customer_segment: { type: "STRING" },
                    product_categories: { type: "STRING" },
                    company_size: { type: "STRING" },
                    geographic_coverage: { type: "STRING" },
                    personas_and_solutions: {
                      type: "OBJECT",
                      properties: {
                        personas: {
                          type: "ARRAY",
                          items: {
                            type: "OBJECT",
                            properties: {
                              name: { type: "STRING" },
                              role: { type: "STRING" },
                              needs: { type: "ARRAY", items: { type: "STRING" } },
                              pain_points: { type: "ARRAY", items: { type: "STRING" } },
                            },
                            required: ["name", "needs"],
                          },
                        },
                        solutions: {
                          type: "ARRAY",
                          items: {
                            type: "OBJECT",
                            properties: {
                              name: { type: "STRING" },
                              value: { type: "STRING" },
                              target_persona: { type: "STRING" },
                            },
                            required: ["name", "value"],
                          },
                        },
                      },
                      required: ["personas", "solutions"],
                    },
                    found_contacts: {
                      type: "ARRAY",
                      items: {
                        type: "OBJECT",
                        properties: {
                          first_name: { type: "STRING" },
                          last_name: { type: "STRING" },
                          title: { type: "STRING" },
                          email: { type: "STRING" },
                          cellphone: { type: "STRING" },
                          whatsapp: { type: "STRING" },
                          linkedin_url: { type: "STRING" },
                          source: { type: "STRING" },
                        },
                      },
                    },
                    business_type: { type: "STRING" },
                    product_category: { type: "STRING" },
                    target_market: { type: "STRING" },
                    remarks: { type: "STRING" },
                  },
                  required: ["customer_segment", "personas_and_solutions", "remarks"],
                },
              },
            }),
          },
        );
        if (response.ok) {
          const payload: unknown = await response.json();
          const content = (
            payload as { candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }> }
          ).candidates?.[0]?.content?.parts?.[0]?.text;
          if (typeof content === "string") {
            await noteProviderKeySuccess(env, "gemini", entry);
            return parseAnalysis(content);
          }
        }
        if (response.status === 429) {
          // Key quota exhausted for now: cool it down and rotate to next key
          await markKeyExhausted(env, "gemini", healthName, GEMINI_KEY_COOLDOWN_MS, `HTTP 429 on ${m}`);
          await noteProviderKeyError(env, "gemini", entry, `HTTP 429 on ${m}`);
          break; // next key
        }        } catch (e) {
          // An abort must propagate: the shared controller is already dead, so
          // "trying the next model" would fail instantly and mask the real
          // (timeout) cause as a misleading "all providers unavailable".
          if (controller.signal.aborted) {
            throw new Error(`AI处理超时（${Math.round(AI_TIMEOUT_MS / 1000)}秒内未完成）`);
          }
          /* otherwise try next model */
        }
    }
  }
  return null;
}

async function analyzeWithGroq(
  customer: CustomerRow,
  researchContext: string,
  env: Env,
  controller: AbortController,
): Promise<CustomerAnalysis | null> {
  const fallbackModel = env.GROQ_MODEL || "llama-3.1-70b-versatile";
  const state = await getProviderState(env, "groq");
  if (!isProviderUsable(state)) return null;
  const groqRpmLimit = state.rpmTotal ?? rpmLimitFor("groq", state.keys.length, rpmEnvOverride(env, "groq"));
  for (const entry of state.keys) {
    if (!tryAcquireRpmSlot("groq", entry.rpmLimit ?? groqRpmLimit)) return null;
    try {
      const analysis = await openaiCompatibleAnalyze("https://api.groq.com/openai/v1/chat/completions", entry.key, entry.model || fallbackModel, customer, researchContext, controller);
      await noteProviderKeySuccess(env, "groq", entry);
      return analysis;
    } catch (e) {
      await noteProviderKeyError(env, "groq", entry, e instanceof Error ? e.message : String(e));
    }
  }
  return null;
}

async function analyzeWithCerebras(
  customer: CustomerRow,
  researchContext: string,
  env: Env,
  controller: AbortController,
): Promise<CustomerAnalysis | null> {
  // llama-3.3-70b: free tier serves 70B-class models; 8B failed to follow the
  // strict JSON extraction schema reliably on crawler-grade tasks.
  const fallbackModel = env.CEREBRAS_MODEL || "llama-3.3-70b";
  const state = await getProviderState(env, "cerebras");
  if (!isProviderUsable(state)) return null;
  const cerebrasRpmLimit = state.rpmTotal ?? rpmLimitFor("cerebras", state.keys.length, rpmEnvOverride(env, "cerebras"));
  for (const entry of state.keys) {
    if (!tryAcquireRpmSlot("cerebras", entry.rpmLimit ?? cerebrasRpmLimit)) return null;
    try {
      const analysis = await openaiCompatibleAnalyze("https://api.cerebras.ai/v1/chat/completions", entry.key, entry.model || fallbackModel, customer, researchContext, controller);
      await noteProviderKeySuccess(env, "cerebras", entry);
      return analysis;
    } catch (e) {
      await noteProviderKeyError(env, "cerebras", entry, e instanceof Error ? e.message : String(e));
    }
  }
  return null;
}

async function analyzeWithMistral(
  customer: CustomerRow,
  researchContext: string,
  env: Env,
  controller: AbortController,
): Promise<CustomerAnalysis | null> {
  const fallbackModel = env.MISTRAL_MODEL || "mistral-large-latest";
  const state = await getProviderState(env, "mistral");
  if (!isProviderUsable(state)) return null;
  const mistralRpmLimit = state.rpmTotal ?? rpmLimitFor("mistral", state.keys.length, rpmEnvOverride(env, "mistral"));
  for (const entry of state.keys) {
    if (!tryAcquireRpmSlot("mistral", entry.rpmLimit ?? mistralRpmLimit)) return null;
    try {
      const analysis = await openaiCompatibleAnalyze("https://api.mistral.ai/v1/chat/completions", entry.key, entry.model || fallbackModel, customer, researchContext, controller);
      await noteProviderKeySuccess(env, "mistral", entry);
      return analysis;
    } catch (e) {
      await noteProviderKeyError(env, "mistral", entry, e instanceof Error ? e.message : String(e));
    }
  }
  return null;
}

async function analyzeWithDeepSeek(
  customer: CustomerRow,
  researchContext: string,
  env: Env,
  controller: AbortController,
): Promise<CustomerAnalysis | null> {
  const fallbackModel = env.DEEPSEEK_MODEL || "deepseek-chat";
  const state = await getProviderState(env, "deepseek");
  if (!isProviderUsable(state)) return null;
  const deepseekRpmLimit = state.rpmTotal ?? rpmLimitFor("deepseek", state.keys.length, rpmEnvOverride(env, "deepseek"));
  for (const entry of state.keys) {
    if (!tryAcquireRpmSlot("deepseek", entry.rpmLimit ?? deepseekRpmLimit)) return null;
    try {
      const analysis = await openaiCompatibleAnalyze("https://api.deepseek.com/v1/chat/completions", entry.key, entry.model || fallbackModel, customer, researchContext, controller);
      await noteProviderKeySuccess(env, "deepseek", entry);
      return analysis;
    } catch (e) {
      await noteProviderKeyError(env, "deepseek", entry, e instanceof Error ? e.message : String(e));
    }
  }
  return null;
}

async function analyzeWithZhipu(
  customer: CustomerRow,
  researchContext: string,
  env: Env,
  controller: AbortController,
): Promise<CustomerAnalysis | null> {
  // glm-4.7-flash: 30B-class, 200K context, permanently free — well above
  // glm-4-flash for structured crawler-data extraction.
  const fallbackModel = env.ZHIPU_MODEL || "glm-4.7-flash";
  const state = await getProviderState(env, "zhipu");
  if (!isProviderUsable(state)) return null;
  const zhipuRpmLimit = state.rpmTotal ?? rpmLimitFor("zhipu", state.keys.length, rpmEnvOverride(env, "zhipu"));
  for (const entry of state.keys) {
    if (!tryAcquireRpmSlot("zhipu", entry.rpmLimit ?? zhipuRpmLimit)) return null;
    try {
      const analysis = await openaiCompatibleAnalyze("https://open.bigmodel.cn/api/paas/v4/chat/completions", entry.key, entry.model || fallbackModel, customer, researchContext, controller);
      await noteProviderKeySuccess(env, "zhipu", entry);
      return analysis;
    } catch (e) {
      await noteProviderKeyError(env, "zhipu", entry, e instanceof Error ? e.message : String(e));
    }
  }
  return null;
}

async function analyzeWithNvidia(
  customer: CustomerRow,
  researchContext: string,
  env: Env,
  controller: AbortController,
): Promise<CustomerAnalysis | null> {
  const fallbackModel = env.NVIDIA_MODEL || "meta/llama-3.3-70b-instruct";
  const state = await getProviderState(env, "nvidia");
  if (!isProviderUsable(state)) return null;
  const nvidiaRpmLimit = state.rpmTotal ?? rpmLimitFor("nvidia", state.keys.length, rpmEnvOverride(env, "nvidia"));
  for (const entry of state.keys) {
    if (!tryAcquireRpmSlot("nvidia", entry.rpmLimit ?? nvidiaRpmLimit)) return null;
    try {
      const analysis = await openaiCompatibleAnalyze("https://integrate.api.nvidia.com/v1/chat/completions", entry.key, entry.model || fallbackModel, customer, researchContext, controller);
      await noteProviderKeySuccess(env, "nvidia", entry);
      return analysis;
    } catch (e) {
      await noteProviderKeyError(env, "nvidia", entry, e instanceof Error ? e.message : String(e));
    }
  }
  return null;
}

async function analyzeWithOpenRouter(
  customer: CustomerRow,
  researchContext: string,
  env: Env,
  controller: AbortController,
): Promise<CustomerAnalysis | null> {
  const fallbackModel = env.OPENROUTER_MODEL || "google/gemini-2.5-flash";
  const state = await getProviderState(env, "openrouter");
  if (!isProviderUsable(state)) return null;
  const openrouterRpmLimit = state.rpmTotal ?? rpmLimitFor("openrouter", state.keys.length, rpmEnvOverride(env, "openrouter"));
  for (const entry of state.keys) {
    if (!tryAcquireRpmSlot("openrouter", entry.rpmLimit ?? openrouterRpmLimit)) return null;
    try {
      const analysis = await openaiCompatibleAnalyze("https://openrouter.ai/api/v1/chat/completions", entry.key, entry.model || fallbackModel, customer, researchContext, controller);
      await noteProviderKeySuccess(env, "openrouter", entry);
      return analysis;
    } catch (e) {
      await noteProviderKeyError(env, "openrouter", entry, e instanceof Error ? e.message : String(e));
    }
  }
  return null;
}

async function analyzeWithAmd(
  customer: CustomerRow,
  researchContext: string,
  env: Env,
  controller: AbortController,
): Promise<CustomerAnalysis | null> {
  // AMD Radeon Cloud free model APIs (OpenAI-compatible). Registration:
  // https://developer.amd.com.cn/radeon/tokenfactory (GitHub login, no card).
  const fallbackModel = env.AMD_MODEL || "DeepSeek-V4-Flash";
  const state = await getProviderState(env, "amd");
  if (!isProviderUsable(state)) return null;
  const amdRpmLimit = state.rpmTotal ?? rpmLimitFor("amd", state.keys.length, rpmEnvOverride(env, "amd"));
  for (const entry of state.keys) {
    if (!tryAcquireRpmSlot("amd", entry.rpmLimit ?? amdRpmLimit)) return null;
    try {
      // AMD public free endpoint: JSON mode unreliable → prompt hint only;
      // parseAnalysis still validates/normalizes the output.
      const analysis = await openaiCompatibleAnalyze("https://developer.amd.com.cn/radeon/api/v1/chat/completions", entry.key, entry.model || fallbackModel, customer, researchContext, controller, false);
      await noteProviderKeySuccess(env, "amd", entry);
      return analysis;
    } catch (e) {
      await noteProviderKeyError(env, "amd", entry, e instanceof Error ? e.message : String(e));
    }
  }
  return null;
}

async function analyzeCustomer(
  customer: CustomerRow,
  researchContext: string,
  env: Env,
): Promise<CustomerAnalysis> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  // Truthful timeout reporting: once the shared controller fires, every later
  // provider call dies instantly — surface that as a timeout instead of the
  // misleading "all providers unavailable" (which previously looped forever).
  const ensureNotAborted = () => {
    if (controller.signal.aborted) {
      throw new Error(`AI处理超时（${Math.round(AI_TIMEOUT_MS / 1000)}秒内未完成）`);
    }
  };
  try {
    const providers: Array<Promise<boolean>> = [
      "gemini", "groq", "cerebras", "mistral", "deepseek", "zhipu", "nvidia", "amd", "openrouter",
    ].map(async (p) => isProviderUsable(await getProviderState(env, p)));
    const hasAnyProviderKey = (await Promise.all(providers)).some(Boolean);
    if (!hasAnyProviderKey) {
      // Configuration error, not transient: fail immediately with a clear
      // message so the panel shows what is actually missing.
      throw new Error("所有AI Provider均不可用，请配置至少一个AI API Key");
    }
    // Try Gemini first
    let result = await analyzeWithGemini(customer, researchContext, env, controller);
    if (result) return result;
    ensureNotAborted();

    // Fallback to Groq
    result = await analyzeWithGroq(customer, researchContext, env, controller);
    if (result) return result;
    ensureNotAborted();

    // Fallback to Cerebras (fast open models, free tier)
    result = await analyzeWithCerebras(customer, researchContext, env, controller);
    if (result) return result;
    ensureNotAborted();

    // Fallback to Zhipu GLM-4-Flash (permanently free, China-direct)
    result = await analyzeWithZhipu(customer, researchContext, env, controller);
    if (result) return result;
    ensureNotAborted();

    // Fallback to NVIDIA NIM (free credits, sits late to conserve them)
    result = await analyzeWithNvidia(customer, researchContext, env, controller);
    if (result) return result;
    ensureNotAborted();

    // Fallback to AMD Radeon Cloud (free model APIs: DeepSeek-V4-Flash etc.)
    result = await analyzeWithAmd(customer, researchContext, env, controller);
    if (result) return result;
    ensureNotAborted();

    // Fallback to Mistral
    result = await analyzeWithMistral(customer, researchContext, env, controller);
    if (result) return result;
    ensureNotAborted();

    // Fallback to DeepSeek
    result = await analyzeWithDeepSeek(customer, researchContext, env, controller);
    if (result) return result;
    ensureNotAborted();

    // Fallback to OpenRouter
    result = await analyzeWithOpenRouter(customer, researchContext, env, controller);
    if (result) return result;
    ensureNotAborted();

    // Keys exist but every provider declined (rate limits, server errors).
    // Transient — the message makes isRetryableAiError() re-queue it.
    throw new Error("所有AI Provider暂时不可用（限流或服务错误），将在下个周期重试");
  } finally {
    clearTimeout(timer);
  }
}

async function claimCustomers(env: Env): Promise<CustomerRow[]> {
  // Recover jobs abandoned by a timed-out invocation before claiming new work.
  await env.DB.prepare(`
    UPDATE customers
    SET status = 'pending', updated_at = CURRENT_TIMESTAMP
    WHERE status = 'processing'
      AND updated_at < datetime('now', '-${STALE_PROCESSING_MINUTES} minutes')
  `).run();

  // One UPDATE atomically claims the first three pending rows. This avoids the
  // SELECT-then-UPDATE race between overlapping Cron invocations.
  const result = await env.DB.prepare(`
    UPDATE customers
    SET status = 'processing', updated_at = CURRENT_TIMESTAMP
    WHERE id IN (
      SELECT id FROM customers
      WHERE status = 'pending'
      ORDER BY id
      LIMIT ?
    )
    RETURNING id, company_id, display_id, domain, status, company_name, country, customer_segment, personas_and_solutions, remarks
  `  ).bind(BATCH_SIZE).all<CustomerRow>();
  return result.results;
}

// ── Pre-AI data cleaning ──
// Crawled pages are full of navigation menus, cookie banners, legal boilerplate
// and repeated headers. Feeding them to the AI wastes tokens (and TPM quota)
// without adding signal. This stage is deterministic, free, and runs before any
// provider is called. Line granularity keeps contact lines and list items.
const CLEAN_MIN_LINE_LENGTH = 4;
const CLEAN_MAX_BLOCK_CHARS = 4_500;
const CLEAN_MAX_TOTAL_CHARS = 30_000;
const CLEAN_BLOCK_SEPARATOR = "\n";
// Lines that are pure navigation/UI noise (footer, menus, legal boilerplate).
const CLEAN_NOISE_LINE_PATTERNS = [
  /^home\b/i, /^about us$/i, /^contact us$/i, /^privacy policy$/i,
  /^terms (of|&(amp;)? )?(use|service)/i, /^cookie(s| policy)?$/i,
  /^all rights reserved/i, /^©/, /^copyright /i, /^skip to (main )?content/i,
  /^sign in$/i, /^log ?in$/i, /^subscribe$/i, /^newsletter$/i,
  /^accept( all)? cookies?$/i, /^read more$/i, /^learn more$/i,
  /^share (this|on)\b/i, /^follow us\b/i, /^back to top$/i,
  /^[»«‹›»<\-–—•·|\s]+$/, // bare decorative separators
];

/**
 * Deduplicate and strip boilerplate from the research context before sending
 * it to the AI. Removes exact-duplicate lines (crawled pages repeat menus on
 * every sub-page), UI noise lines, then trims each source block and the whole
 * context to a token budget. Preserves head lines of each block (section
 * headers like "=== 搜索结果: ... ===" carry source attribution the AI uses).
 */
function cleanResearchContextForAi(raw: string): string {
  // 1. Split into source blocks (sections separated by "=== ... ===" headers)
  const blocks = raw.split(/(?=={3}\s)/g);
  const cleanedBlocks: string[] = [];
  const seenBlockHashes = new Set<string>();

  for (const block of blocks) {
    const lines = block.split("\n");
    // Block header ("=== ... ===") is always kept: it tells the AI the source.
    const header = lines[0]?.includes("===") ? lines[0] : "";
    const bodyLines = header ? lines.slice(1) : lines;

    const keptLines: string[] = [];
    const seenLines = new Set<string>();
    let blockChars = 0;
    for (const line of bodyLines) {
      const trimmed = line.trim();
      if (trimmed.length < CLEAN_MIN_LINE_LENGTH) continue; // drop fragments
      if (CLEAN_NOISE_LINE_PATTERNS.some((p) => p.test(trimmed))) continue;
      const key = trimmed.toLowerCase();
      if (seenLines.has(key)) continue; // intra-block duplicate (repeated menu)
      seenLines.add(key);
      if (blockChars + trimmed.length > CLEAN_MAX_BLOCK_CHARS) break;
      keptLines.push(trimmed);
      blockChars += trimmed.length;
    }

    if (keptLines.length === 0 && !header) continue;
    const cleaned = [header, ...keptLines].filter(Boolean).join(CLEAN_BLOCK_SEPARATOR);
    // Cross-block dedupe: sub-pages of the same site often collapse to the
    // same content after cleaning; keep only the first.
    const blockHash = cleaned.replace(/\s+/g, "").toLowerCase();
    if (blockHash.length < 20) continue; // blocks with too little signal
    if (seenBlockHashes.has(blockHash)) continue;
    seenBlockHashes.add(blockHash);
    cleanedBlocks.push(cleaned);
  }

  // 3. Global budget: join blocks until the total char budget is used.
  let total = "";
  for (const block of cleanedBlocks) {
    if (total.length + block.length > CLEAN_MAX_TOTAL_CHARS) {
      const remaining = CLEAN_MAX_TOTAL_CHARS - total.length;
      if (remaining > 500) total += CLEAN_BLOCK_SEPARATOR + block.slice(0, remaining);
      break;
    }
    total += (total ? CLEAN_BLOCK_SEPARATOR : "") + block;
  }
  return total;
}

function isRetryableAiError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message;
  // Gemini 429 (rate limit), 500/502/503/504 (server errors) are retryable
  for (const code of AI_RETRYABLE_STATUSES) {
    if (msg.includes(`HTTP ${code}`)) return true;
  }
  // All providers busy (rate limited / transient server errors): re-queue for
  // the next cron run instead of burning the record as a permanent failure.
  if (msg.includes("暂时不可用")) return true;
  return false;
}

async function processCustomer(customer: CustomerRow, env: Env): Promise<D1PreparedStatement> {
  const retryCount = getRetryCount(customer.remarks);
  try {
    // Step 1: Fetch main website and extract social media links
    let pageText = "";
    let socialLinks: string[] = [];
    try {
      const response = await fetchWebsite(normalizeDomain(customer.domain));
      if (!response.ok) {
        // 环节1 降级回退: bot-blocked (403/503) or JS-rendered pages get one
        // Firecrawl attempt (headless renderer, LLM-clean markdown) before
        // the site is treated as unreachable.
        if (BLOCKED_WEBSITE_STATUSES.has(response.status)) {
          const markdown = await firecrawlScrape(normalizeDomain(customer.domain), env);
          if (markdown && markdown.length > 100) {
            pageText = markdown.slice(0, 15_000);
          } else {
            throw websiteError(response);
          }
        } else {
          throw websiteError(response);
        }
      } else {
        pageText = await extractPageText(response);
        socialLinks = await extractLinks(response);
      }
    } catch (e) {
      if (e instanceof Error && !e.message.includes("HTTP 404")) {
        // For non-404 errors, still try to gather info from other sources
      } else {
        throw e;
      }
    }

    // Step 1b: Verify social media links
    const verifiedSocial = await verifySocialMedia(socialLinks);
    const verifiedSocialJson = JSON.stringify(verifiedSocial);
    await env.DB.prepare(
      `UPDATE customers SET social_accounts_verified = ? WHERE id = ?`
    ).bind(verifiedSocialJson, customer.id).run();

    // Step 2: Google search for company information
    const companyName = customer.company_name || customer.company_id;
    const country = customer.country || "";
    const googleResults = await searchCompanyInfo(companyName, country, env, customer.id, customer.domain);

    // Step 3: Fetch additional sources (sub-pages, social media)
    const additionalText = await fetchAdditionalSources(companyName, customer.domain, env);

    // Step 4: Combine all research data
    const socialInfo = verifiedSocial.length > 0
      ? `\n\n=== 已验证社交媒体 ===\n${verifiedSocial.map((s) => `${s.platform}: ${s.url} (${s.verified ? "已验证" : "未验证"})`).join("\n")}`
      : "";
    const researchContext = pageText
      ? `=== 主网站内容 ===\n${pageText}${socialInfo}${googleResults}${additionalText}`
      : `=== 主网站无法访问 ===${socialInfo}${googleResults}${additionalText}`;

    if (researchContext.length < 50) {
      throw new Error("无法从任何来源获取有效信息");
    }

    // Step 4: Save full research text to database (raw context kept for audit
    // and re-analysis without re-crawling)
    const trimmedResearch = researchContext.slice(0, 50_000);
    await env.DB.prepare(
      `UPDATE customers SET full_research_text = ? WHERE id = ?`
    ).bind(trimmedResearch, customer.id).run();

    // Step 4b: Clean the raw context BEFORE the AI call — dedupe repeated
    // menus/boilerplate across sources and trim to a token budget so paid/free
    // quotas are spent on signal, not navigation junk.
    const researchForAi = cleanResearchContextForAi(researchContext);

    // Step 5: AI deep analysis
    const analysis = await analyzeCustomer(customer, researchForAi, env);
    const personas = JSON.stringify(analysis.personas_and_solutions);
    const remarks = withCompanyMarker(analysis.remarks, customer.company_id);

    // Step 5: Save found contacts to contacts table
    if (analysis.found_contacts && analysis.found_contacts.length > 0) {
      // Get current max seq for this company
      const maxSeqResult = await env.DB.prepare(
        `SELECT COALESCE(MAX(seq), 0) AS max_seq FROM contacts WHERE company_id = ?`
      ).bind(customer.company_id).first<{ max_seq: number }>();
      let nextSeq = (maxSeqResult?.max_seq ?? 0) + 1;

      // Load existing contact fingerprints for this company so re-researched
      // companies don't accumulate duplicate rows on retry.
      const existing = await env.DB.prepare(
        `SELECT first_name, last_name, email, cellphone, whatsapp FROM contacts WHERE company_id = ?`
      ).bind(customer.company_id).all<{ first_name: string | null; last_name: string | null; email: string | null; cellphone: string | null; whatsapp: string | null }>();
      const fingerprint = (c: { first_name?: string | null; last_name?: string | null; email?: string | null; cellphone?: string | null; whatsapp?: string | null }) =>
        [c.first_name, c.last_name, c.email, c.cellphone, c.whatsapp].map((v) => (v || "").trim().toLowerCase()).join("|");
      const seen = new Set((existing.results ?? []).map(fingerprint));

      const contactStmts: D1PreparedStatement[] = [];
      for (const ct of analysis.found_contacts) {
        // Only save contacts with at least a name or email
        const hasName = ct.first_name || ct.last_name;
        const hasContact = ct.email || ct.cellphone || ct.whatsapp;
        if (!hasName && !hasContact) continue;

        const fp = fingerprint(ct);
        if (seen.has(fp)) continue; // skip duplicates (within batch and vs. DB)
        seen.add(fp);

        const contactId = `${customer.display_id || customer.company_id}_${String(nextSeq).padStart(3, "0")}`;
        contactStmts.push(
          env.DB.prepare(
            `INSERT OR IGNORE INTO contacts (contact_id, company_id, seq, first_name, last_name, title, email, cellphone, whatsapp, linkedin_url, department)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(
            contactId,
            customer.company_id,
            nextSeq,
            ct.first_name || null,
            ct.last_name || null,
            ct.title || null,
            ct.email || null,
            ct.cellphone || null,
            ct.whatsapp || null,
            ct.linkedin_url || null,
            ct.source || null,
          )
        );
        nextSeq++;
      }
      if (contactStmts.length > 0) {
        await env.DB.batch(contactStmts);
      }
    }

    return env.DB.prepare(`
      UPDATE customers
      SET status = 'completed', customer_segment = ?, product_categories = ?, company_size = ?, geographic_coverage = ?, personas_and_solutions = ?, remarks = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'processing'
    `).bind(analysis.customer_segment, analysis.product_categories, analysis.company_size, analysis.geographic_coverage, personas, remarks, customer.id);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // Rate-limit rejections (429 / full-pool cooldown) are infinite-retry:
    // they depend on other tasks releasing quota, not on this record being
    // broken, so they must never consume a retry slot or burn the record.
    const isRateLimit = reason.includes("HTTP 429") || reason.includes("暂时不可用") || reason.includes("AI处理超时");
    const shouldRetry = isRetryableAiError(error) && (isRateLimit || retryCount < MAX_RETRIES);

    if (shouldRetry) {
      const cleanRemarks = stripRetryTag(customer.remarks ?? "");
      const nextRetryTag = `\n[retry:${retryCount + 1}]`;
      const remarks = withCompanyMarker(`${cleanRemarks}${nextRetryTag}处理失败（第${retryCount + 1}次重试）：${reason}`, customer.company_id);
      return env.DB.prepare(`
        UPDATE customers
        SET status = 'pending', remarks = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'processing'
      `).bind(remarks, customer.id);
    }

    // Multi-Step Crawling & Fallback skill: bot-blocked (403) sites must not
    // burn retry slots forever — they are tagged for manual review instead.
    // The admin panel can list them via remarks and re-queue after a fix.
    const needsManualReview = reason.includes("HTTP 403");
    const failureLabel = needsManualReview
      ? `需人工复审（反爬拦截，已尝试 Firecrawl 降级仍未成功）：${reason}`
      : `处理失败：${reason}`;
    const remarks = withCompanyMarker(failureLabel, customer.company_id);
    return env.DB.prepare(`
      UPDATE customers
      SET status = 'failed', remarks = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'processing'
    `).bind(remarks, customer.id);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const adminEnv = { ...env } as import("./admin").AdminEnv;
    const adminResponse = await handleAdminRequest(request, adminEnv);
    return adminResponse ?? new Response("Not Found", { status: 404 });
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const customers = await claimCustomers(env);
    if (!customers.length) return;
    // Process sequentially with delays to respect Gemini rate limits
    const updates: D1PreparedStatement[] = [];
    for (let i = 0; i < customers.length; i++) {
      if (i > 0) await sleep(INTER_CUSTOMER_DELAY_MS);
      updates.push(await processCustomer(customers[i], env));
    }
    await env.DB.batch(updates);
    ctx.waitUntil(Promise.resolve());
  },
} satisfies ExportedHandler<Env>;
