# Stage 52 — Role-priority picking (engine)

Phase 9 (docs/phase9-contact-multi-touch.md §2). Committed: `phase9: stage 52`.

## What shipped

- **`SegmentFilters.rolePriority: string[]`** — ordered role keywords,
  `role_priority`/`rolePriority` keys, `sanitizeList` at
  `MAX_ROLE_PRIORITY = 5` (trim/dedup/50-char cap like every list).
  Ignore-at-use with company grain: a saved group's JSON keeps parsing
  across grain flips; a company-grain campaign never becomes per-person
  because of it.
- **`contactRankSql`** (campaigns.ts) — the ONE ranking, shared by the
  preview pick and the create snapshot (Stage 49/51 invariant: the
  preview must count exactly what the snapshot adopts). ORDER BY becomes
  `CASE WHEN ct.title LIKE ?roleN ESCAPE '\' THEN N-1 ... ELSE M END,
  ct.seq, ct.id`. Empty keywords → "" → byte-compatible Phase 8 order.
  `escapeLike` neutralizes `%`/`_`/`\` so a keyword matches itself only.
- **previewSegment** — contactPick embeds the rank; bind order fixed for
  the sample query (`brandName, rank…, clause…`) and the covered query
  (`clause…, brandName, rank…`) — the rank ?s sit inside the embedded
  subquery, so textual position rules.
- **createCampaign** — snapshot pick uses the same rank prefix; rank
  binds precede the IN-chunk ids (subquery lives in the SELECT list).

## Verified facts recorded

- SQLite `LIKE` is ASCII-case-insensitive (CJK keywords unaffected).
- Bind order is strictly textual in SQLite; both call sites covered by
  the rank-consistency test (a draft on the ranked pick counts as
  coverage; on the unranked pick it does not).

## Tests — tests/campaign-role-priority.test.ts (11)

- parse/serialize roundtrip (snake+camel, trim/dedup, legacy absent key);
  >5 keywords rejected; company-grain payload with role_priority keeps
  parsing (ignore-at-use).
- contactRankSql: no-keyword degeneration (Phase 8 golden); LIKE escape
  binds (`%a\_b%`, `%50\%%`); ESCAPE clause; branch order = operator
  order.
- Snapshot: role match beats lower seq; multi-keyword operator order;
  `_`/`%` literal (no wildcard widening); no-keyword = lowest seq;
  company grain ignores the field (contact_id stays NULL).
- Preview: already-coverage follows the SAME ranked pick the snapshot
  would take — same DB, different rank → different coverage verdict.

## Gates

- vitest 910/910 (70 files; +11 new)
- tsc --noEmit: 0
- wrangler dry-run: 598.63 KiB / gzip 145.86 KiB
- No panel/admin.ts change this stage (check-panel not required; Stage 54
  will run it as a hard gate).

## Deferred to Stage 53/54

- Multi-contact snapshot (`contacts_per_company`) needs the members
  grain rebuild (0028) — Stage 53.
- Panel inputs + persona_role options endpoint + slot displays — Stage 54.
