import { execSync } from "node:child_process";

const raw = execSync(
  `npx wrangler d1 execute crm-ai-db --remote --json --command "SELECT id, api_key FROM api_configs WHERE provider='gemini' AND is_active=1 ORDER BY id;"`,
  { encoding: "utf8", timeout: 120_000, stdio: ["pipe", "pipe", "pipe"] },
);
const parsed = JSON.parse(raw.slice(raw.indexOf("[")));
const keys = parsed[0].results;

const mask = (k) => `${k.slice(0, 6)}…${k.slice(-4)}`;

for (const { id, api_key: key } of keys) {
  for (const model of ["gemini-3.6-flash", "gemini-2.5-flash"]) {
    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
      body: JSON.stringify({ model, max_tokens: 5, messages: [{ role: "user", content: "hi" }] }),
    });
    const verdict = r.status === 200 ? "OK" : `HTTP ${r.status}`;
    console.log(`#${id} ${mask(key)} + ${model} -> ${verdict}`);
    if (r.status !== 200 && model === "gemini-3.6-flash") {
      const t = await r.text();
      console.log("   ", t.replace(/\s+/g, " ").slice(0, 150));
    }
  }
}
