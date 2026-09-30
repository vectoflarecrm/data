/* Sanity-check the admin panel template literal: the JS must parse, ids must
 * be unique, and every getElementById() must have a matching element. */
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/admin.ts", import.meta.url), "utf8");
const marker = "const OUTREACH_PANEL_HTML = `";
const start = src.indexOf(marker);
if (start < 0) throw new Error("OUTREACH_PANEL_HTML not found");
const from = start + marker.length;
const end = src.indexOf("`;", from);
if (end < 0) throw new Error("template literal terminator not found");
const html = src.slice(from, end);

// Undo the template-literal escaping so this is the bytes the browser sees.
const panel = html.replace(/\\`/g, "`").replace(/\\\$\{/g, "${").replace(/\\\\/g, "\\");

const script = [...panel.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
console.log(`script blocks: ${script.length}`);
let bad = 0;
for (const [i, code] of script.entries()) {
  try {
    new Function(code);
    console.log(`  [${i}] parses OK (${code.length} chars)`);
  } catch (e) {
    bad++;
    console.error(`  [${i}] PARSE ERROR: ${e.message}`);
    const line = /(\d+)/.exec(e.stack ?? "");
    if (line) console.error(code.split("\n").slice(Math.max(0, +line[1] - 4), +line[1] + 2).join("\n"));
  }
}

const ids = [...panel.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
console.log(`\nelement ids: ${ids.length}, duplicates: ${[...new Set(dupes)].join(", ") || "none"}`);
if (dupes.length) bad++;

const wanted = new Set([...panel.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]));
const missing = [...wanted].filter((id) => !ids.includes(id));
console.log(`getElementById targets: ${wanted.size}, missing: ${missing.join(", ") || "none"}`);
if (missing.length) bad++;

console.log(bad ? `\nFAILED (${bad})` : "\nOK");
process.exit(bad ? 1 : 0);
