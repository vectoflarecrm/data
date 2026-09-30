/* Sanity-check the admin panel template literals: the JS must parse, ids must
 * be unique, and every getElementById() must have a matching element.
 *
 * Every `const *_HTML = \`` block in src/admin.ts is checked. Keying off a
 * single named panel left the others unverified, and the keys panel is exactly
 * where hand-written JS lives — the one that grows when credentials are added
 * or the pool is encrypted. */
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/admin.ts", import.meta.url), "utf8");

const blocks = [...src.matchAll(/^const (\w*_HTML) = `/gm)];
if (blocks.length === 0) throw new Error("no *_HTML template literals found in src/admin.ts");

// Undo the template-literal escaping so this is the bytes the browser sees.
const unescape = (html) =>
  html.replace(/\\`/g, "`").replace(/\\\$\{/g, "${").replace(/\\\\/g, "\\");

function extractPanel(name, from) {
  // Panels are written as one HTML blob per literal, terminated by a backtick
  // followed by a semicolon at end of line. Scanning for a bare backtick would
  // stop at an escaped one, so match the terminator on a line of its own tail.
  const rest = src.slice(from);
  const end = rest.search(/`;[ \t]*$/m);
  if (end < 0) throw new Error(`unterminated template literal for ${name}`);
  return unescape(rest.slice(0, end));
}

let bad = 0;
for (const [i, block] of blocks.entries()) {
  const name = block[1];
  const from = block.index + block[0].length;
  console.log(`\n── ${name}`);
  let panel;
  try {
    panel = extractPanel(name, from);
  } catch (e) {
    console.error(`  EXTRACT FAILED: ${e.message}`);
    bad++;
    continue;
  }

  const script = [...panel.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  for (const [j, code] of script.entries()) {
    try {
      new Function(code);
      console.log(`  script[${j}] parses OK (${code.length} chars)`);
    } catch (e) {
      bad++;
      console.error(`  script[${j}] PARSE ERROR: ${e.message}`);
      const line = /(\d+)/.exec(e.stack ?? "");
      if (line) {
        const n = +line[1];
        console.error(code.split("\n").slice(Math.max(0, n - 4), n + 2).join("\n"));
      }
    }
  }

  // Only static ids: rows rendered in a loop build ids like `id="inp_'+f.key+'"`,
  // which are unique per row by construction and are not grep-able.
  const ids = [...panel.matchAll(/\sid="([^"+$]*)"/g)]
    .map((m) => m[1])
    .filter((id) => id.length > 0);
  const dupes = [...new Set(ids.filter((id, j) => ids.indexOf(id) !== j))];
  if (dupes.length) {
    bad++;
    console.error(`  duplicate ids: ${dupes.join(", ")}`);
  }

  // Both quote styles: panels here use getElementById('x') and
  // document.getElementById("x") in different places.
  const wanted = new Set([
    ...[...panel.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]),
    ...[...panel.matchAll(/getElementById\("([^"]+)"\)/g)].map((m) => m[1]),
  ]);
  const missing = [...wanted].filter((id) => !ids.includes(id));
  if (missing.length) {
    bad++;
    console.error(`  getElementById with no element: ${missing.join(", ")}`);
  }

  if (script.length) {
    console.log(`  ids: ${ids.length}, getElementById targets: ${wanted.size}`);
  }
}

console.log(bad ? `\nFAILED (${bad} problem(s) across ${blocks.length} panels)` : `\nOK — ${blocks.length} panels clean`);
process.exit(bad ? 1 : 0);
