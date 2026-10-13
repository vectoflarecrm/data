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

// Evaluate the template literal exactly as TS does, so the bytes checked here
// are the bytes the browser receives. The old three-regex "unescape" kept
// `\n` as two characters, which validated different text than the served
// page: a `\n` inside a panel JS string shipped as a real newline, split the
// string literal in half, and killed the whole panel script with a
// SyntaxError while this checker still reported "parses OK".
function unescape(raw) {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c !== "\\") { out += c; continue; }
    const n = raw[++i];
    if (n === undefined) { out += "\\"; break; }
    if (n === "n") out += "\n";
    else if (n === "t") out += "\t";
    else if (n === "r") out += "\r";
    else if (n === "b") out += "\b";
    else if (n === "f") out += "\f";
    else if (n === "v") out += "\v";
    else if (n === "0") out += "\0";
    else if (n === "`" || n === "$" || n === "\\") out += n;
    else if (n === "\n") { /* line continuation: swallow the break */ }
    else if (n === "\r") { if (raw[i + 1] === "\n") i++; }
    else if (n === "x") {
      const hex = raw.slice(i + 1, i + 3);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) { out += String.fromCharCode(parseInt(hex, 16)); i += 2; }
      else out += "x";
    } else if (n === "u") {
      if (raw[i + 1] === "{") {
        const close = raw.indexOf("}", i + 2);
        const hex = raw.slice(i + 2, close);
        if (close > 0 && /^[0-9a-fA-F]{1,6}$/.test(hex)) { out += String.fromCodePoint(parseInt(hex, 16)); i = close; }
        else out += "u";
      } else {
        const hex = raw.slice(i + 1, i + 5);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) { out += String.fromCharCode(parseInt(hex, 16)); i += 4; }
        else out += "u";
      }
    } else out += n; // NonEscapeCharacter identity: \d -> d, \s -> s, ...
  }
  return out;
}

function extractPanel(name, from) {
  // Panels are written as one HTML blob per literal, terminated by a backtick
  // followed by a semicolon at end of line. Scanning for a bare backtick would
  // stop at an escaped one, so match the terminator on a line of its own tail.
  // Returns the RAW template text; escape evaluation happens in the caller.
  const rest = src.slice(from);
  const end = rest.search(/`;[ \t]*$/m);
  if (end < 0) throw new Error(`unterminated template literal for ${name}`);
  return rest.slice(0, end);
}

let bad = 0;
for (const [i, block] of blocks.entries()) {
  const name = block[1];
  const from = block.index + block[0].length;
  console.log(`\n── ${name}`);
  let panel;
  try {
    // Two steps, both needed: first scan the RAW executable-script regions for
    // identity escapes that evaluation would silently rewrite (\d -> d etc.) —
    // those corrupt regexes without ever producing a syntax error; then
    // evaluate the escapes to get the served bytes for the parse check.
    const rawPanel = extractPanel(name, from);
    for (const sm of rawPanel.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
      for (const esc of sm[1].matchAll(/\\(.)/gs)) {
        if (!"ntrbfvxu0`$\\\n\r".includes(esc[1])) {
          bad++;
          console.error(`  raw '\\${esc[1]}' in script serves as '${esc[1]}' — write '\\\\${esc[1]}' to serve a backslash escape`);
        }
      }
    }
    panel = unescape(rawPanel);
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
