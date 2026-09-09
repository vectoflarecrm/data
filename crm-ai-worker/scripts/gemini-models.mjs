import { execSync } from "node:child_process";

const raw = execSync(
  `npx wrangler d1 execute crm-ai-db --remote --json --command "SELECT id, api_key FROM api_configs WHERE provider='gemini' AND is_active=1 AND api_key LIKE 'AQ.%' LIMIT 1;"`,
  { encoding: "utf8", timeout: 120_000, stdio: ["pipe", "pipe", "pipe"] },
);
const parsed = JSON.parse(raw.slice(raw.indexOf("[")));
const key = parsed[0].results[0].api_key;

// List models accessible to this key (OpenAI-style endpoint)
const r = await fetch("https://generativelanguage.googleapis.com/v1beta/openai/models", {
  headers: { "Authorization": `Bearer ${key}` },
});
const text = await r.text();
console.log("HTTP", r.status);
try {
  const data = JSON.parse(text);
  const ids = (data.data ?? []).map((m) => m.id).filter((id) => id.includes("flash") || id.includes("pro"));
  console.log("models containing flash/pro:", ids.slice(0, 20));
} catch {
  console.log(text.slice(0, 500));
}
