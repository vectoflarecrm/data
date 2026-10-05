# Stage 30 — Panel class restyle: drop `style-src-attr 'unsafe-inline'` (post-V2)

Closes the final report's last CSP-related deferred-improvements entry
(Remaining Risks #1). After this stage the admin CSP is fully nonce-based:
no `'unsafe-inline'` and no `'unsafe-eval'` anywhere.

## Threat model

Stage 5's accepted residual risk: panel HTML used `style=""` attributes, and
attributes cannot carry a nonce, so the CSP needed
`style-src-attr 'unsafe-inline'`. Script execution was never at stake (CSS
cannot run script and every dynamic innerHTML sink is escaped); the exposure
was defacement of the panel by an already-authenticated operator. This stage
removes the escape hatch entirely.

## What shipped

- `scripts/style-to-class.mjs` — one-shot transformer (kept for history and
  future panel edits):
  - collected every **static** `style="…"` value in `src/admin.ts` (149
    distinct values, 221+ occurrences), curated short names for the 31
    most-used values (`s-num`, `s-hidden`, `s-seclabel`, `s-input`, …) and
    deterministic slugs for the singletons;
  - three replacement patterns, all constrained to `[^<>]` so a match can
    never span tags: `class="X" … style="V"` (merge), `style="V" … class="X"`
    (merge, reordered), and bare `style="V"` → `class="CLS"`;
  - injected each panel's used rules at the **end** of its `<style>` block —
    class specificity is (0,1,0), so the injected rules must come last in
    the sheet to keep beating the panels' own single-class rules, which
    preserves the previous inline-override order exactly;
  - collision checks (slug vs curated names), per-value replacement counts,
    leftover-`style=` and duplicate-`class=` sanity output.
- Six dynamic (JS-concatenated) style sites, converted by hand:
  - ADMIN score histogram: bar color variants (`sf-hi/good/mid/low/none`)
    + `data-w` width attribute, back-filled via CSSOM
    (`$c.querySelectorAll('.score-fill').forEach(el => el.style.width = …)`)
    — CSSOM assignment is not an HTML attribute, so CSP does not restrict it;
  - ADMIN verified-social / evidence confidence: conditional color classes
    (`sv-ok/sv-bad`, `ev-hi/mid/lo`);
  - OUTREACH campaign bar: `.cp-seg` segments carry `data-w`, back-filled
    after the list `innerHTML`;
  - OUTREACH members drawer: failed/sent row colors (`mo-fail/mo-ok`);
  - KEYS usage bar: `pb-fill` + `pb-hot/warm/ok` variants + `data-w`,
    back-filled after `box.innerHTML=h`;
  - three conditional `' disabled style="opacity:.45"'` appends became
    `' disabled cg-off'` with `.cg-off{opacity:.45}` — deliberately **not**
    a `[disabled]` attribute selector: the busy-state cg-gen button sets
    `disabled=true` programmatically and was never dimmed before; a broad
    `[disabled]` rule would have changed that.
- **Latent bug found and fixed**: the ADMIN customer-list 查看详情 button used
  `onclick="window.openDetail(…)"` — an inline event handler, which the
  nonce-based `script-src` (no `unsafe-inline`) had **already been blocking
  in real browsers** since Stage 5; tests never execute panel JS, so it sat
  undetected. Converted to `data-open` + one delegated listener on `#rows`
  (`addEventListener`, property-assignment handlers are CSP-exempt).
- `showMsg` (ADMIN) rewritten from `className='notice success'` (which wipes
  all other classes — it would have destroyed the newly merged `s-mra` on
  `#modalMsg`) to `classList` add/remove/toggle, preserving utility classes.
- `src/security-headers.ts`: `style-src-attr 'unsafe-inline'` removed; the
  tech-debt comment replaced with the stage-30 rationale.
- `tests/security-headers.test.ts`: the CSP test now asserts `unsafe-inline`
  and `style-src-attr` are absent entirely.

## Visual-parity discipline

- Every class body is the verbatim former declaration — no redesign, no
  value normalization.
- Same style value ⇒ same class name across panels (deterministic), each
  panel's `<style>` gets only the rules it uses.
- The merge report was reviewed against every compound selector in the
  panels (`.btn.on/.off/.del/.gray`, `.tab.active`, `.badge.off`,
  `.modal-overlay.active`, `.toast.err`): no merged element is targeted by a
  higher-specificity compound rule on the same property, so the (0,1,0)
  late-injected utilities keep winning where inline style used to.
- Elements hidden via inline `display:none` and shown via CSSOM
  (`el.style.display=…`) — the cg buttons, tab-content divs, copyBtn — keep
  working: CSSOM assignment overrides the class rule.

## Verification

- `style="` attribute count in `src/admin.ts`: **0** (was 221 static + 6
  dynamic + 3 conditional). Remaining `.style.` accesses (37) are all CSSOM
  property assignments, unrestricted by CSP.
- Duplicate `class="…"` attribute scan: 0.
- `check-panel.mjs`: 7 panels clean, all scripts parse.
- Full suite **642/642 (52 files)**, `tsc --noEmit` clean, dry-run
  526.27 KiB / gzip 130.02 KiB (+5.7 KiB raw / +2.4 KiB gzip from the
  injected utility CSS — accepted).
- Docs updated: `security-limitations.md` §4 struck, final report Remaining
  Risks #1 and the deferred entry struck, `deployment-v2.md` §5 gate numbers.

## Operational notes

- No migration, no env var, no API change — deploy is a plain worker update;
  panels render identically, CSP one directive shorter.
- Future panel code: keep styles in classes (or CSSOM); a new `style=""`
  attribute would be silently dropped by browsers under the current CSP.
- `scripts/style-to-class.mjs` is idempotent by report (re-run prints
  "NO CHANGES" once nothing matches) and excluded from the worker bundle
  (scripts/ is not imported).
