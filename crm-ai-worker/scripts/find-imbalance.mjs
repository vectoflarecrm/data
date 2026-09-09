import { readFileSync } from "node:fs";

const src = readFileSync("src/admin.ts", "utf8");
const line = src.split("\n").find((l) => l.includes("enable-toggle"));
if (!line) {
  console.error("loadBrands line not found");
  process.exit(1);
}

// Track bracket depth while skipping string literals, template literals,
// regex-ish slashes and comments the way JS does (well enough for this line).
let depth = 0;
let inStr = null; // ' or " or `
let prev = "";
const events = [];
const markers = [
  ["card loop end          </p>'})", "}});"],
  ["brand-card forEach end ", "loadAttachments(brand)});"],
  ["enable-toggle forEach  ", "el.checked=!enabled"],
  ["att-upload forEach end ", "reader.readAsDataURL(file)}"],
  ["save-brand forEach end ", "showToast(brand+' 配置已保存"],
  ["line end               ", "__END__"],
];

for (let i = 0; i < line.length; i++) {
  const c = line[i];
  if (inStr) {
    if (c === "\\") i++;
    else if (c === inStr) inStr = null;
  } else {
    if (c === "'" || c === '"' || c === "`") inStr = c;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth < 0) {
        console.log(`NEGATIVE depth ${depth} at index ${i}: ...${JSON.stringify(line.slice(Math.max(0, i - 50), i + 10))}`);
        process.exit(0);
      }
    }
  }
  for (const [name, m] of markers) {
    if (m !== "__END__" && line.startsWith(m, i)) events.push([i, depth, name]);
  }
}
events.push([line.length, depth, "line end               "]);

console.log("depth at statement boundaries (should return to 2 inside loadBrands body, 1 at closing):");
let lastD = null;
for (const [idx, d, name] of events) {
  console.log(`  idx ${String(idx).padStart(5)}  depth ${d}  ${name}  ${d !== lastD ? "  <-- CHANGED" : ""}`);
  lastD = d;
}
console.log("final depth:", depth, inStr ? "(UNTERMINATED STRING: " + inStr + ")" : "");
