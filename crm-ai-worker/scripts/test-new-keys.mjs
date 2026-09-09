import { execSync } from "node:child_process";

// 1. Pull keys from D1 (keys never printed — only masked results)
const raw = execSync(
  `npx wrangler d1 execute crm-ai-db --remote --json --command "SELECT provider, id, api_key FROM api_configs WHERE is_active = 1 AND provider IN ('gemini','exa','tavily') ORDER BY provider, id;"`,
  { encoding: "utf8", timeout: 120_000, stdio: ["pipe", "pipe", "pipe"] },
);
const parsed = JSON.parse(raw.slice(raw.indexOf("[")));
const rows = parsed[0].results;

const mask = (k) => `${k.slice(0, 6)}…${k.slice(-4)}`;

// 2. Minimal live calls per provider
async function testKey(provider, key) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  try {
    if (provider === "gemini") {
      const r = await fetch("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
        body: JSON.stringify({
          model: "gemini-2.5-flash",
          max_tokens: 5,
          messages: [{ role: "user", content: "hi" }],
        }),
        signal: controller.signal,
      });
      const t = await r.text();
      return { status: r.status, body: t.slice(0, 120) };
    }
    if (provider === "exa") {
      const r = await fetch("https://api.exa.ai/search", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": key },
        body: JSON.stringify({ query: "test", numResults: 1 }),
        signal: controller.signal,
      });
      const t = await r.text();
      return { status: r.status, body: t.slice(0, 120) };
    }
    if (provider === "tavily") {
      const r = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: key, query: "test", max_results: 1 }),
        signal: controller.signal,
      });
      const t = await r.text();
      return { status: r.status, body: t.slice(0, 120) };
    }
    return { status: 0, body: "unknown provider" };
  } finally {
    clearTimeout(timer);
  }
}

// 3. Run with small concurrency, print masked verdicts
const groups = {};
for (const r of rows) (groups[r.provider] ??= []).push(r);

for (const [provider, list] of Object.entries(groups)) {
  console.log(`\n=== ${provider.toUpperCase()} (${list.length} keys) ===`);
  const results = await Promise.all(
    list.map(async (r) => {
      let res;
      try {
        res = await testKey(provider, r.api_key);
      } catch (e) {
        res = { status: 0, body: `network error: ${e.message?.slice(0, 60)}` };
      }
      const verdict =
        res.status === 200 ? "OK" :
        res.status === 401 || res.status === 403 ? "INVALID" :
        res.status === 429 ? "RATE-LIMITED (key likely valid)" :
        `HTTP ${res.status}`;
      console.log(`  #${r.id} ${mask(r.api_key)} -> ${verdict}`);
      if (res.status !== 200) console.log(`      ${res.body.replace(/\n/g, " ").slice(0, 110)}`);
      return verdict;
    }),
  );
  const ok = results.filter((v) => v === "OK" || v.startsWith("RATE")).length;
  console.log(`  summary: ${ok}/${results.length} usable`);
}
