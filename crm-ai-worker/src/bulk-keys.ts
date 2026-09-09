// Bulk key-import line parser (used by POST /admin/api/keys/bulk).
//
// Accepted template format — one entry per line:
//   API Key,备注/账号     (label keeps its commas; only the FIRST comma splits)
//   API Key<TAB>备注      (Excel/Sheets two-column paste)
//   API Key|备注
//   API Key               (bare key — caller applies label-prefix numbering)
//
// Also tolerant of: surrounding whitespace, quoted labels ("账号1" / '账号1'),
// comma/semicolon-separated bare keys on a single line (legacy format),
// and blank lines. Keys shorter than 8 chars are treated as noise and dropped.

export interface BulkKeyEntry {
  key: string;
  label: string | null;
}

// A token that "looks like an API key": long ASCII run with dashes/underscores.
const KEY_LIKE = /^[A-Za-z0-9_-]{8,}$/;

export function parseBulkKeyEntries(raw: string): BulkKeyEntry[] {
  const entries: BulkKeyEntry[] = [];
  const seen = new Set<string>();

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let pieces: string[];
    let bareBatch = false; // legacy one-line batch of bare keys (no labels)
    if (trimmed.includes("\t") || trimmed.includes("|")) {
      // Excel/Sheets paste or explicit pipe separator
      pieces = trimmed.split(/[\t|]+/);
    } else if (trimmed.includes(",")) {
      const idx = trimmed.indexOf(",");
      const rest = trimmed.slice(idx + 1).trim();
      // Remainder starts with another key-shaped token → legacy bare batch
      // ("key1,key2;key3"), not "key,label". KEY_LIKE: long ASCII run with
      // dashes/underscores — labels like "账号1" or "采购部,备用" never match.
      if (KEY_LIKE.test(rest) || KEY_LIKE.test(rest.split(/[,;\s]/)[0] ?? "")) {
        pieces = trimmed.split(/[,;\s]+/);
        bareBatch = true;
      } else {
        // "key,label…" — split ONLY on the first comma so labels keep commas
        pieces = [trimmed.slice(0, idx), rest];
      }
    } else {
      // Legacy single-line batches: semicolon/space separated bare keys
      pieces = trimmed.split(/[;\s]+/);
      bareBatch = true;
    }

    if (bareBatch) {
      // Every piece is a key — push them all (dedupe applies)
      for (const piece of pieces) {
        const k = piece.trim();
        if (k.length < 8 || seen.has(k)) continue;
        seen.add(k);
        entries.push({ key: k, label: null });
      }
      continue;
    }

    const key = (pieces[0] ?? "").trim().replace(/^["']+|["']+$/g, "").trim();
    if (key.length < 8 || seen.has(key)) continue;

    // "key,label…": pieces[1..] form the label (re-joined so commas inside
    // labels survive). Quotes around the label are trimmed.
    const label = pieces.length > 1
      ? pieces.slice(1).join(",").trim().replace(/^["']+[ "']*|[ "']*["']+$/g, "").trim()
      : "";
    seen.add(key);
    entries.push({ key, label: label || null });
  }

  return entries;
}
