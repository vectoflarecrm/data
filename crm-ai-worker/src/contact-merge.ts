/* Phase 7 Stage 47 (docs/phase7-contact-merge.md §2/§4): pure write-time
 * contact dedup planner.
 *
 * The old Step 5 only skipped EXACT fingerprint duplicates
 * (first|last|email|cell|whatsapp lowercased), so the same person found
 * again with a NEW channel (an email added, a phone found later) landed as
 * a second row. The planner keeps the fingerprint skip verbatim and adds a
 * deliberately conservative same-person rule on top:
 *
 *   same channel identity (normalized email / cellphone / whatsapp)
 *   AND compatible names (equal, or at least one side unnamed)
 *   → MERGE into the existing row, fill-NULL-only
 *
 * Name-only matches and channel matches with CONFLICTING names never merge
 * automatically (a shared info@ mailbox can front two people; two people
 * can share a name) — those stay separate and merge by hand (Stage 48).
 *
 * Pure on purpose: index.ts Step 5 feeds it the company's existing rows
 * plus this run's found_contacts and executes the returned statements
 * verbatim, so the decision logic is unit-testable without the AI
 * pipeline, and the SQL itself is testable on node:sqlite. The module is a
 * leaf (imports nothing from admin/index) — same rationale as
 * lead-score-dims.
 */

export interface ExistingContact {
  contact_id: string;
  first_name: string | null;
  last_name: string | null;
  title: string | null;
  department: string | null;
  email: string | null;
  cellphone: string | null;
  whatsapp: string | null;
  linkedin_url: string | null;
}

/** What the research analysis yields per person (index.ts found_contacts). */
export interface IncomingContact {
  first_name?: string;
  last_name?: string;
  title?: string;
  email?: string;
  cellphone?: string;
  whatsapp?: string;
  linkedin_url?: string;
  source?: string;
}

export interface PlannedStatement {
  sql: string;
  binds: Array<string | number | null>;
}

export interface ContactPlan {
  /** UPDATEs (recorded in merge order) then INSERTs (creation order). */
  statements: PlannedStatement[];
  skipped: number;
  merged: number;
  inserted: number;
}

/** The one true fingerprint (unchanged from the pre-Phase-7 Step 5). */
function fingerprint(c: {
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  cellphone?: string | null;
  whatsapp?: string | null;
}): string {
  return [c.first_name, c.last_name, c.email, c.cellphone, c.whatsapp]
    .map((v) => (v || "").trim().toLowerCase())
    .join("|");
}

function normText(v: string | null | undefined): string {
  return (v || "").trim().toLowerCase();
}

/** Phones compare like the Stage 42 linkage: case/trim + separators
 * (space, hyphen, parens, dot) stripped. TRANSLATE is SQLite 3.47+ and
 * absent from node:sqlite, so there it was nested REPLACE — here it is a
 * regex with the exact same character class. */
export function normalizePhone(v: string | null | undefined): string {
  return normText(v).replace(/[ \-().]/g, "");
}

function nameOf(c: { first_name?: string | null; last_name?: string | null }): string {
  return [c.first_name, c.last_name].map(normText).filter(Boolean).join(" ");
}

function channelIdentityMatches(
  row: { email: string | null; cellphone: string | null; whatsapp: string | null },
  ct: { email?: string; cellphone?: string; whatsapp?: string },
): boolean {
  const email = normText(ct.email);
  if (email && email === normText(row.email)) return true;
  const cell = normalizePhone(ct.cellphone);
  if (cell && cell === normalizePhone(row.cellphone)) return true;
  const wa = normalizePhone(ct.whatsapp);
  if (wa && wa === normalizePhone(row.whatsapp)) return true;
  return false;
}

/** Equal names, or at least one side unnamed (an unnamed channel row is
 * compatible with the named person who owns that channel). */
function namesCompatible(
  row: { first_name?: string | null; last_name?: string | null },
  ct: { first_name?: string; last_name?: string },
): boolean {
  const a = nameOf(row);
  const b = nameOf(ct);
  return a === b || a === "" || b === "";
}

const MERGE_FIELDS = [
  "first_name",
  "last_name",
  "title",
  "department",
  "email",
  "cellphone",
  "whatsapp",
  "linkedin_url",
] as const;

/** The COALESCE fill: SQL itself enforces "never overwrite a non-null" —
 * a null incoming value keeps the row's value, a non-null incoming value
 * fills only a null. */
const MERGE_SQL =
  `UPDATE contacts SET ${MERGE_FIELDS.map((f) => `${f} = COALESCE(${f}, ?)`).join(", ")}
   WHERE contact_id = ? AND company_id = ?`;

interface WorkingRow extends ExistingContact {
  /** Only provisional rows carry a seq (the INSERT needs it); existing
   * rows keep their DB seq and never re-emit it. */
  seq: number | null;
  provisional: boolean;
}

/** Fill the row's NULL fields from the incoming contact — the in-memory
 * mirror of the SQL COALESCE fill, so later matches see enriched rows. */
function fillNulls(row: WorkingRow, ct: IncomingContact): void {
  if (row.first_name == null && ct.first_name) row.first_name = ct.first_name;
  if (row.last_name == null && ct.last_name) row.last_name = ct.last_name;
  if (row.title == null && ct.title) row.title = ct.title;
  if (row.department == null && ct.source) row.department = ct.source;
  if (row.email == null && ct.email) row.email = ct.email;
  if (row.cellphone == null && ct.cellphone) row.cellphone = ct.cellphone;
  if (row.whatsapp == null && ct.whatsapp) row.whatsapp = ct.whatsapp;
  if (row.linkedin_url == null && ct.linkedin_url) row.linkedin_url = ct.linkedin_url;
}

export function planContactPersist(params: {
  existing: ExistingContact[];
  incoming: IncomingContact[];
  companyId: string;
  nextSeq: number;
  contactIdPrefix: string;
}): ContactPlan {
  const { existing, incoming, companyId, nextSeq, contactIdPrefix } = params;
  const statements: PlannedStatement[] = [];
  const rows: WorkingRow[] = existing.map((r) => ({ ...r, seq: null, provisional: false }));
  const fpSeen = new Set(rows.map(fingerprint));
  let seq = nextSeq;
  let skipped = 0;
  let merged = 0;
  let inserted = 0;

  for (const ct of incoming) {
    // Same admission guard as the old Step 5: a person needs at least a
    // name or one channel, anything less is not a contact.
    const hasName = ct.first_name || ct.last_name;
    const hasContact = ct.email || ct.cellphone || ct.whatsapp;
    if (!hasName && !hasContact) {
      skipped++;
      continue;
    }

    const fp = fingerprint(ct);
    if (fpSeen.has(fp)) {
      skipped++; // exact duplicate (within batch or vs. DB) — unchanged
      continue;
    }
    fpSeen.add(fp);

    const match = rows.find(
      (row) => channelIdentityMatches(row, ct) && namesCompatible(row, ct),
    );
    if (match) {
      if (match.provisional) {
        // The match is a row this same batch will insert — fold the new
        // channels into the eventual INSERT values instead of emitting an
        // UPDATE that would run before its row exists.
        fillNulls(match, ct);
      } else {
        statements.push({
          sql: MERGE_SQL,
          binds: [
            ct.first_name || null,
            ct.last_name || null,
            ct.title || null,
            ct.source || null,
            ct.email || null,
            ct.cellphone || null,
            ct.whatsapp || null,
            ct.linkedin_url || null,
            match.contact_id,
            companyId,
          ],
        });
        // Keep the in-memory view current so later contacts match against
        // the enriched row (batch UPDATEs run sequentially, same result).
        fillNulls(match, ct);
      }
      merged++;
      continue;
    }

    rows.push({
      contact_id: `${contactIdPrefix}${String(seq).padStart(3, "0")}`,
      seq,
      first_name: ct.first_name || null,
      last_name: ct.last_name || null,
      title: ct.title || null,
      department: ct.source || null,
      email: ct.email || null,
      cellphone: ct.cellphone || null,
      whatsapp: ct.whatsapp || null,
      linkedin_url: ct.linkedin_url || null,
      provisional: true,
    });
    seq++;
    inserted++;
  }

  for (const row of rows) {
    if (!row.provisional) continue;
    statements.push({
      sql: `INSERT OR IGNORE INTO contacts (contact_id, company_id, seq, first_name, last_name, title, email, cellphone, whatsapp, linkedin_url, department)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      binds: [
        row.contact_id,
        companyId,
        row.seq,
        row.first_name,
        row.last_name,
        row.title,
        row.email,
        row.cellphone,
        row.whatsapp,
        row.linkedin_url,
        row.department,
      ],
    });
  }

  return { statements, skipped, merged, inserted };
}
