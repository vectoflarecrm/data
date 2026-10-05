// Stage 30 one-shot transformer: convert static inline style="" attributes in
// src/admin.ts panel templates to utility classes, so CSP can drop
// style-src-attr 'unsafe-inline'.
//
// - Only STATIC style values are mapped (no quotes/plus inside the value).
// - opacity:.45 is EXCLUDED: it appears as conditional `' disabled style=...'`
//   appends and is fixed manually via a [disabled] CSS rule.
// - Dynamic (JS-concatenated) styles at 6 known sites are fixed by hand.
// - After replacement the script injects, before each panel's first
//   </style>, the CSS rules for the classes used in that panel.
// - Injection goes at the END of each style block so that, at equal
//   specificity (0,1,0), the utility class wins over the panel's own
//   single-class rules - preserving the old inline-style override order.
//
// Run: node scripts/style-to-class.mjs   (prints a report; writes src/admin.ts)
import { readFileSync, writeFileSync } from "node:fs";

const FILE = "src/admin.ts";
const EXCLUDED = new Set(["opacity:.45"]); // manual: .btn[disabled]-scoped rules

const CURATED = {
  "text-align:right;padding:4px 8px": "s-num",
  "display:none": "s-hidden",
  "font-weight:600;font-size:13px;color:#475569;display:block;margin-top:10px": "s-seclabel",
  "color:#6b7280;margin:4px 0": "s-muted",
  "font-size:13px": "s-fs13",
  "color:#94a3b8": "s-faint",
  "color:red": "s-red-loud",
  "min-width:130px": "s-mw130",
  "font-size:12px;color:#6b7280": "s-hint12",
  "padding:10px;border:1px solid #cbd5e1;border-radius:8px;font:inherit": "s-input-lg",
  "display:flex;gap:8px;flex-wrap:wrap;align-items:center": "s-row",
  "margin-top:8px": "s-mt8",
  "color:#16a34a;margin:4px 0": "s-ok",
  "color:#6b7280": "s-gray",
  "padding:9px 22px": "s-btnlg",
  "overflow-x:auto": "s-scrollx",
  "margin-top:10px": "s-mt10",
  "flex:1;padding:6px 8px;border:1px solid #cbd5e1;border-radius:6px;font-size:13px": "s-input-flex",
  "min-width:90px": "s-mw90",
  "display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center": "s-between",
  "padding:8px;border:1px solid #cbd5e1;border-radius:6px;font-size:13px;width:150px": "s-input150",
  "padding:8px;border:1px solid #cbd5e1;border-radius:6px;font-size:13px": "s-input",
  "font-size:13px;color:#475569;margin:6px 0": "s-note",
  "font-size:13px;display:flex;align-items:center;gap:4px": "s-chiprow",
  "color:#6b7280;margin:0": "s-gray0",
  "color:#9ca3af": "s-faint2",
  "font-size:13px;color:#475569;margin:0 0 10px": "s-intro",
  "color:#dc2626;font-size:13px": "s-red13",
  "padding:4px 8px": "s-pad48",
};

const PROP = {
  "text-align": "ta", "font-weight": "fw", "font-size": "fs", "font-family": "ff",
  "font-style": "fst", "color": "c", "background": "bg", "padding": "p",
  "margin": "m", "margin-top": "mt", "margin-bottom": "mb", "margin-left": "ml",
  "margin-right": "mr", "width": "w", "height": "h", "min-width": "mw",
  "min-height": "mh", "max-width": "xw", "max-height": "xh", "border": "bd",
  "border-top": "bdt", "border-left": "bdl", "border-right": "bdr",
  "border-bottom": "bdb", "border-radius": "br", "display": "d", "gap": "g",
  "align-items": "ai", "justify-content": "jc", "flex": "fx", "flex-wrap": "fxw",
  "flex-direction": "fxd", "white-space": "ws", "line-height": "lh",
  "word-break": "wb", "overflow": "ov", "overflow-x": "ovx", "overflow-y": "ovy",
  "position": "pos", "opacity": "op", "cursor": "cur", "grid-column": "gc",
  "text-decoration": "td", "box-sizing": "bs", "place-items": "pi", "font": "f",
  "top": "t", "left": "l", "right": "r", "bottom": "bt", "z-index": "zi",
  "box-shadow": "bsh", "transform": "tr", "vertical-align": "va",
  "letter-spacing": "ls", "text-overflow": "to", "list-style": "ls2",
};
const VAL = {
  "flex": "fx", "block": "b", "none": "n", "inline-block": "ib", "column": "col",
  "auto": "a", "hidden": "h", "bold": "b", "normal": "n", "monospace": "mono",
  "pre-wrap": "pw", "break-all": "ba", "break-word": "bw", "pointer": "ptr",
  "solid": "sol", "relative": "rel", "italic": "it", "inherit": "inh",
  "left": "l", "right": "r", "center": "c", "space-between": "sb", "wrap": "w",
  "nowrap": "nw", "start": "st", "end": "end", "baseline": "base", "grid": "grid",
  "system-ui": "sysui", "sans-serif": "sans", "inline-flex": "ifx",
  "ellipsis": "ell", "uppercase": "uc", "underline": "ul", "middle": "mid",
};
const valRe = Object.keys(VAL)
  .sort((a, b) => b.length - a.length)
  .map((k) => k.replace(/[.*+?^${}()|[\]\\-]/g, (ch) => (ch === "-" ? "\\-" : "\\$&")))
  .join("|");
const valRx = new RegExp(`(?:^|[^a-z0-9-])(${valRe})(?![a-z0-9-])`, "g");

function slugify(v) {
  const parts = v.split(";").filter(Boolean).map((d) => {
    const i = d.indexOf(":");
    const prop = d.slice(0, i).trim();
    let val = d.slice(i + 1).trim();
    val = val.replace(valRx, (mm, word) => mm.replace(word, VAL[word]));
    val = val
      .replace(/#/g, "")
      .replace(/px/g, "")
      .replace(/%/g, "")
      .replace(/[-()\\s,:.'"\/]/g, "");
    const p = PROP[prop] || prop.replace(/-/g, "");
    return p + val;
  });
  return "s-" + parts.join("-");
}

let src = readFileSync(FILE, "utf8");
const before = src;

// 1) collect static style values
const counts = new Map();
for (const m of src.matchAll(/style="([^"'+]*)"/g)) {
  const v = m[1];
  counts.set(v, (counts.get(v) || 0) + 1);
}

// 2) build value -> class map (curated first, then slugs), collision-checked
const clsOf = new Map();
const used = new Map(); // className -> value (for collision reporting)
for (const v of Object.keys(CURATED)) {
  if (!counts.has(v)) continue;
  clsOf.set(v, CURATED[v]);
  used.set(CURATED[v], v);
}
for (const [v] of counts) {
  if (clsOf.has(v) || EXCLUDED.has(v)) continue;
  let cls = slugify(v);
  while (used.has(cls)) cls += "x";
  clsOf.set(v, cls);
  used.set(cls, v);
}

// 3) replace: A (class..style), A2 (style..class), B (bare)
const merges = []; // { cls, origClass }
const repCount = new Map();
for (const [v, cls] of clsOf) {
  let n = 0;
  const esc = v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const a = new RegExp(`class="([^"]*)"([^<>]*?)style="${esc}"`, "g");
  src = src.replace(a, (_mm, c, mid) => {
    n++;
    merges.push({ cls, origClass: c });
    return `class="${c} ${cls}"${mid}`;
  });
  const a2 = new RegExp(`style="${esc}"([^<>]*?)class="([^"]*)"`, "g");
  src = src.replace(a2, (_mm, mid, c) => {
    n++;
    merges.push({ cls, origClass: c });
    return `class="${cls} ${c}"${mid}`;
  });
  const b = new RegExp(`style="${esc}"`, "g");
  src = src.replace(b, () => {
    n++;
    return `class="${cls}"`;
  });
  repCount.set(cls, n);
}

// 4) per-panel usage + CSS injection before each panel's first </style>
const anchors = [
  "const ADMIN_LOGIN_HTML",
  "const ADMIN_PANEL_HTML",
  "const OUTREACH_PANEL_HTML",
  "const KEYS_PANEL_HTML",
  "const AUDIT_PANEL_HTML",
  "const SESSIONS_PANEL_HTML",
  "function mfaChallengePage",
  "const SECURITY_PANEL_HTML",
];
const bounds = anchors.map((a) => src.indexOf(a));
bounds.push(src.length);
const panelNames = [
  "ADMIN_LOGIN", "ADMIN", "OUTREACH", "KEYS", "AUDIT", "SESSIONS",
  "MFA_CHALLENGE", "SECURITY",
];
const cssByPanel = new Map();
for (let i = 0; i < anchors.length; i++) {
  if (bounds[i] < 0) throw new Error(`anchor not found: ${anchors[i]}`);
  const seg = src.slice(bounds[i], bounds[i + 1]);
  const rules = [];
  for (const [v, cls] of clsOf) {
    const rx = new RegExp(`class="[^"]*\\b${cls}\\b[^"]*"`);
    if (rx.test(seg)) rules.push(`.${cls}{${v}}`);
  }
  if (rules.length === 0) continue;
  const closeIdx = seg.indexOf("</style>");
  if (closeIdx < 0) throw new Error(`no </style> in ${panelNames[i]}`);
  const inject = `\n/* stage30 auto: inline style -> class */\n${rules.join("\n")}\n`;
  const at = bounds[i] + closeIdx;
  src = src.slice(0, at) + inject + src.slice(at);
  cssByPanel.set(panelNames[i], rules.length);
  // shift later bounds by injected length
  for (let j = i + 1; j <= anchors.length; j++) if (bounds[j] >= 0) bounds[j] += inject.length;
}

// 5) sanity checks
const leftover = [];
for (const m of src.matchAll(/style="/g)) {
  const line = src.slice(0, m.index).split("\n").length;
  const ctx = src.slice(m.index, m.index + 60).replace(/\n/g, "\\n");
  leftover.push(`  L${line}: ${ctx}`);
}
const dup = [];
for (const m of src.matchAll(/class="[^"]*"[^<>]*?class="/g)) {
  const line = src.slice(0, m.index).split("\n").length;
  dup.push(`  L${line}: ${src.slice(m.index, m.index + 90).replace(/\n/g, "\\n")}`);
}

// 6) report
const r = [];
r.push("== value -> class map ==");
for (const [v, cls] of [...clsOf].sort((a, b) => (a[1] < b[1] ? -1 : 1))) {
  r.push(`  ${cls.padEnd(24)} x${String(repCount.get(cls)).padStart(3)}  ${v}`);
}
r.push("");
r.push("== excluded (manual fix) ==");
for (const v of EXCLUDED) r.push(`  ${v} x${counts.get(v) || 0}`);
r.push("");
r.push("== CSS rules injected per panel ==");
for (const [p, n] of cssByPanel) r.push(`  ${p}: ${n} rules`);
r.push("");
r.push("== merges with an existing class (review vs compound selectors) ==");
for (const mrg of merges) r.push(`  +${mrg.cls.padEnd(24)} into "${mrg.origClass.slice(0, 70)}"`);
r.push("");
r.push(`== leftover style=" (${leftover.length}) ==`);
r.push(...leftover);
r.push("");
r.push(`== possible duplicate class attrs (${dup.length}) ==`);
r.push(...dup);

if (src === before) {
  console.log("NO CHANGES - already converted?");
  process.exit(0);
}
writeFileSync(FILE, src);
console.log(r.join("\n"));
console.log(`\nWROTE ${FILE} (delta ${src.length - before.length} chars)`);
