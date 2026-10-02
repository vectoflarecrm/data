# Stage 8 Report — CSV Import Resource Limits

Branch: `feature/security-v2` · Follows: Stage 7 (SSRF / outbound URL guard)

## Goal (spec §9)
The CSV import (`POST /admin/api/customers/import`) was the panel's
resource-consumption entry point: it read the entire JSON body unbounded
(`request.json()`) and parsed the CSV with a loop that had no row, column or
field caps. Stage 8 bounds every dimension (bytes, data rows, field size,
column count), makes the byte cap un-bypassable (chunked uploads without
`Content-Length` included), and pre-positions the §9.3 formula-injection
neutralizer for any future export.

## Changes

### `src/security/csv-limits.ts` (new)
- **Constants** (spec §9.1): `MAX_CSV_BYTES = 5MB` (CSV text),
  `MAX_CSV_ROWS = 2000` (data rows, header excluded),
  `MAX_FIELD_BYTES = 10_000` chars, `MAX_COLUMNS = 200`.
- `CsvLimitError` — typed refusal; `status` is 413 for size, 400 for shape.
- `readCsvImportBody(request)` — bounded read of the `{csv, file_name}` JSON
  envelope:
  1. `Content-Length` fast path: declared size above the cap → 413 before
     any body byte is read;
  2. **stream cap** (the real guard): the body reader is consumed with a
     running total and `reader.cancel()` the moment it exceeds
     `MAX_CSV_BYTES + 64KB` envelope allowance — uploads that omit or lie
     about `Content-Length` cannot bypass;
  3. JSON parse + shape check (`csv` must be a string);
  4. exact limit on the CSV text itself (`> MAX_CSV_BYTES` → 413), so the
     5MB figure is precise regardless of envelope size.
- `parseCsvBounded(text)` — RFC4180-ish parser with limits enforced
  *during* parsing, not after:
  - strips an Excel BOM (`charCodeAt(0) === 0xfeff`) so the first header
    cell still matches;
  - quoted fields with embedded commas, doubled quotes and embedded
    newlines;
  - per-field `MAX_FIELD_BYTES`, per-row `MAX_COLUMNS`, running count of
    data rows vs `MAX_CSV_ROWS` (the first non-empty row is the header —
    required by the import flow — and is excluded from the count);
  - unterminated quote → 400 (malformed); empty rows skipped as before.
- `sanitizeCsvFieldForExport(value)` — §9.3: a cell starting with `=`,
  `+`, `-` or `@` gets a leading apostrophe so spreadsheet apps treat it
  as text. This system has **no CSV export endpoint today**, so imported
  formula-looking text is inert (stored as text, returned as JSON, escaped
  in panels since Stage 5); the sanitizer exists so any future export
  applies it instead of rediscovering the class of bug.

### `src/admin.ts` — `importCustomersCsv` rewired
- body via `readCsvImportBody` (replaces unbounded `request.json()`);
- parsing via `parseCsvBounded` (the inline `parseCsv` loop is removed);
- `CsvLimitError` mapped to its own status (413/400) with the specific
  Chinese detail message; all pre-existing behavior (header check, empty
  csv, per-row insert, response shape) unchanged.

## Tests (+23 → 269 total)
`tests/csv-limits.test.ts` — spec §9.2 list, unit + end-to-end:
- **parser**: valid CSV; BOM; quoted fields (commas, escaped quotes,
  embedded newlines); field > / exactly at `MAX_FIELD_BYTES`; data rows >
  / exactly at `MAX_CSV_ROWS` (header excluded); > `MAX_COLUMNS`;
  unterminated quote.
- **§9.3**: sanitizer unit (= + - @ prefixed, normal text untouched) and
  an import-path test pinning that formula-looking input is stored as
  inert text (per current no-export reality).
- **endpoint**: valid import end-to-end (200, rows inserted); BOM
  recognized end-to-end; >5MB payload → 413 via declared Content-Length;
  oversized **streamed** body without Content-Length → 413 (stream cap);
  row/column/field violations → 400; malformed → 400; prior behavior kept
  (empty csv → 400, missing header → 400 naming `company_name`).
- **`readCsvImportBody` unit**: normal body; non-string `csv` rejected;
  oversized declared body rejected *without parsing*; csv text above the
  exact 5MB limit refused even when the envelope is tiny.

Testing notes (undici): stream bodies need `duplex: "half"`; a
user-supplied `Content-Length` header is ignored (computed from the real
body), so declared-path tests use genuinely oversized bodies.

## Verification
- `npx tsc --noEmit`: pass
- `npm test`: **269/269 pass** (was 246, +23)
- `node scripts/check-panel.mjs`: 4 panels clean
- `npx wrangler deploy --dry-run` (offline): pass

## Security Risks Fixed
- Baseline **#12 (P1)**: unbounded import could buffer arbitrarily large
  bodies and burn CPU on pathological CSVs. Now every dimension is capped,
  the cap cannot be bypassed via chunked transfer, and refusals carry a
  precise status (413 size / 400 shape) and message.

## Not done (by design)
- No CSV export endpoint exists, so §9.3's export-side escaping is
  provided as a ready helper, not wired to a route (wiring a sanitizer
  into a nonexistent feature would be speculative code).
- The header row is not counted toward `MAX_CSV_ROWS`; a headerless file
  would fail the import's existing "缺少 company_name 表头" check anyway.
