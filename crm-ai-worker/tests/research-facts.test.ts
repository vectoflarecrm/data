import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, it, expect } from "vitest";
import {
  appendResearchFacts,
  hasCurrentResearchFacts,
  FACTS_PARSER_VERSION,
  FACTS_PER_RUN_CAP,
  FACT_VALUE_CAP,
} from "../src/research-run";
import { mineResearchFacts } from "../src/index";
import { pruneSupersededResearchFacts } from "../src/data-retention";

/* Phase 3 Stage 37 — typed fact substrate (research_facts).
 *
 * Contract (docs/phase3-research-engine.md §3, 0022 migration):
 *  - append + supersede, never delete: a fresh run flips the previous
 *    current set to is_current = 0 and appends its own rows in ONE batch;
 *  - writer-side bounds: at most FACTS_PER_RUN_CAP rows per run, each
 *    fact_value capped at FACT_VALUE_CAP chars, occurrence_count floored
 *    at 1, confidence defaults to 1 (deterministic observation);
 *  - mineResearchFacts: one entry per distinct (fact_type, fact_value),
 *    first-seen segment as source_type, repeats aggregate into
 *    occurrence_count, junk filtered by the extractContactEvidence rules;
 *  - hasCurrentResearchFacts is the reuse-path gap-fill gate, fail-open on
 *    a missing table;
 *  - the writer is fail-open like appendFieldEvidence;
 *  - retention prunes superseded-only, same policy as evidence/sources.
 */

const SCHEMA_SQL = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");

class FakeD1 {
  constructor(private db: any) {}
  prepare(sql: string) {
    const db = this.db;
    let bound: unknown[] = [];
    const stmt: any = {
      bind(...args: unknown[]) { bound = args; return stmt; },
      all: async () => ({ results: db.prepare(sql).all(...bound), success: true }),
      first: async () => db.prepare(sql).get(...bound) ?? undefined,
      run: async () => {
        const info = db.prepare(sql).run(...bound);
        return { success: true, meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) } };
      },
    };
    return stmt;
  }
  async batch(stmts: any[]) {
    for (const s of stmts) await s.run();
    return [];
  }
}

function makeDb(): any {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA_SQL);
  return db;
}

function rows(db: any, sql: string): any[] {
  return db.prepare(sql).all();
}

describe("appendResearchFacts", () => {
  it("appends fresh facts as current rows with defaults and run link", async () => {
    const db = makeDb();
    await appendResearchFacts({ DB: new FakeD1(db) as any }, {
      companyId: "comp-1",
      runId: "run-1",
      facts: [
        { fact_type: "email", fact_value: "sales@acme.example", source_type: "website" },
        { fact_type: "phone", fact_value: "+1 415 555 2671", source_type: "search", occurrence_count: 3 },
      ],
      now: new Date("2026-03-04T05:06:07Z"),
    });

    const all = rows(db, "SELECT * FROM research_facts ORDER BY id");
    expect(all).toHaveLength(2);
    for (const r of all) {
      expect(r.is_current).toBe(1);
      expect(r.research_run_id).toBe("run-1");
      expect(r.customer_id).toBe("comp-1");
      expect(r.parser_version).toBe(FACTS_PARSER_VERSION);
      expect(r.valid_from).toBe("2026-03-04 05:06:07");
      expect(r.valid_until).toBeNull();
    }
    expect(all[0].fact_type).toBe("email");
    expect(all[0].occurrence_count).toBe(1);
    expect(all[0].confidence).toBe(1);
    expect(all[1].occurrence_count).toBe(3);
  });

  it("supersedes the previous fact set on re-research, never deletes", async () => {
    const db = makeDb();
    const env = { DB: new FakeD1(db) as any };
    await appendResearchFacts(env, {
      companyId: "comp-1",
      runId: "run-1",
      facts: [{ fact_type: "email", fact_value: "old@acme.example", source_type: "website" }],
      now: new Date("2026-03-04T00:00:00Z"),
    });
    await appendResearchFacts(env, {
      companyId: "comp-1",
      runId: "run-2",
      facts: [{ fact_type: "email", fact_value: "new@acme.example", source_type: "website" }],
      now: new Date("2026-03-05T00:00:00Z"),
    });

    const all = rows(db, "SELECT * FROM research_facts ORDER BY id");
    expect(all).toHaveLength(2);
    expect(all[0].is_current).toBe(0);
    expect(all[0].valid_until).toBe("2026-03-05 00:00:00");
    expect(all[0].valid_from).toBe("2026-03-04 00:00:00");
    expect(all[1].is_current).toBe(1);
    expect(all[1].fact_value).toBe("new@acme.example");
  });

  it("keeps other companies' current facts untouched (supersede is per company)", async () => {
    const db = makeDb();
    const env = { DB: new FakeD1(db) as any };
    await appendResearchFacts(env, {
      companyId: "comp-a",
      runId: null,
      facts: [{ fact_type: "email", fact_value: "a@acme.example", source_type: "website" }],
    });
    await appendResearchFacts(env, {
      companyId: "comp-b",
      runId: null,
      facts: [{ fact_type: "email", fact_value: "b@acme.example", source_type: "website" }],
    });
    const current = rows(db, "SELECT customer_id FROM research_facts WHERE is_current = 1 ORDER BY customer_id");
    expect(current.map((r) => r.customer_id)).toEqual(["comp-a", "comp-b"]);
  });

  it("enforces writer-side bounds: row cap, value cap, occurrence floor", async () => {
    const db = makeDb();
    // The long-value entry goes FIRST: the writer keeps the first
    // FACTS_PER_RUN_CAP entries, so a trailing entry would be sliced off.
    const many: Array<{ fact_type: string; fact_value: string; source_type: string; occurrence_count?: number }> = [
      { fact_type: "email", fact_value: "x".repeat(FACT_VALUE_CAP + 100), source_type: "search", occurrence_count: 0 },
    ];
    for (let i = 0; i < FACTS_PER_RUN_CAP + 50; i++) {
      many.push({ fact_type: "email", fact_value: `u${i}@acme.example`, source_type: "website" });
    }
    await appendResearchFacts({ DB: new FakeD1(db) as any }, {
      companyId: "comp-1",
      runId: null,
      facts: many,
    });

    const all = rows(db, "SELECT fact_value, occurrence_count FROM research_facts");
    expect(all).toHaveLength(FACTS_PER_RUN_CAP);
    const longRow = all[0];
    expect(longRow.fact_value.startsWith("xxx") || longRow.fact_value[0] === "x").toBe(true);
    expect(longRow.fact_value).toHaveLength(FACT_VALUE_CAP);
    expect(longRow.occurrence_count).toBe(1);
  });

  it("is fail-open when the table is missing (pre-migration window)", async () => {
    const db = new DatabaseSync(":memory:");
    await expect(appendResearchFacts({ DB: new FakeD1(db) as any }, {
      companyId: "comp-1",
      runId: "run-1",
      facts: [{ fact_type: "email", fact_value: "sales@acme.example", source_type: "website" }],
    })).resolves.toBeUndefined();
  });

  it("tolerates a null run id (fail-open run start) and still records facts", async () => {
    const db = makeDb();
    await appendResearchFacts({ DB: new FakeD1(db) as any }, {
      companyId: "comp-1",
      runId: null,
      facts: [{ fact_type: "email", fact_value: "sales@acme.example", source_type: "website" }],
    });
    const all = rows(db, "SELECT * FROM research_facts");
    expect(all).toHaveLength(1);
    expect(all[0].research_run_id).toBeNull();
  });
});

describe("mineResearchFacts", () => {
  it("mines typed facts from segments with junk filtering", () => {
    const facts = mineResearchFacts([
      {
        source_type: "website",
        text: [
          "Contact us at Sales@Acme.io or logo.png",
          "Tel: +1 415 555 2671 (copyright 2020-2021)",
          "Chat: https://wa.me/8613800138000",
          "Follow: https://www.linkedin.com/company/acme and https://x.com/acme).",
        ].join("\n"),
      },
    ]);
    const values = (type: string) => facts.filter((f) => f.fact_type === type).map((f) => f.fact_value);
    expect(values("email")).toEqual(["sales@acme.io"]);
    expect(values("phone")).toContain("+1 415 555 2671");
    expect(values("whatsapp")).toEqual(["wa.me/8613800138000"]);
    // Same-type second link is a separate fact, trailing ')' excluded.
    expect(values("social")).toEqual(["https://www.linkedin.com/company/acme", "https://x.com/acme"]);
    // As-mined semantics: the digit run inside the wa.me link also surfaces
    // as a phone observation — extractContactEvidence sees the same text
    // the reuse-path facts block has always been built from, so the overlap
    // is not new. The whatsapp fact keeps the full link.
    expect(facts.some((f) => f.fact_type === "phone" && f.fact_value.startsWith("861380"))).toBe(true);
    // Miner junk filters: .png asset filtered, copyright year pair filtered.
    expect(facts.some((f) => f.fact_value.includes(".png"))).toBe(false);
    expect(facts.some((f) => f.fact_value.includes("2020"))).toBe(false);
    // All from one segment: occurrence 1, source recorded.
    for (const f of facts) {
      expect(f.source_type).toBe("website");
      expect(f.occurrence_count).toBe(1);
    }
  });

  it("dedups across segments: first-seen source wins, repeats aggregate", () => {
    const facts = mineResearchFacts([
      { source_type: "website", text: "Reach sales@acme.io — https://wa.me/8613800138000" },
      { source_type: "search", text: "Listed contact: SALES@ACME.IO, wa.me link https://wa.me/8613800138000" },
      { source_type: "additional", text: "Footer repeats sales@acme.io" },
    ]);
    const email = facts.find((f) => f.fact_type === "email");
    expect(email?.source_type).toBe("website");
    expect(email?.occurrence_count).toBe(3);
    const wa = facts.find((f) => f.fact_type === "whatsapp");
    expect(wa?.source_type).toBe("website");
    expect(wa?.occurrence_count).toBe(2);
    // The wa.me digit run surfaces as a phone observation too (as-mined
    // semantics, see the junk-filtering test) and dedups the same way.
    const phoneFromWa = facts.find((f) => f.fact_type === "phone");
    expect(phoneFromWa?.source_type).toBe("website");
    expect(phoneFromWa?.occurrence_count).toBe(2);
  });

  it("bounds output to FACTS_PER_RUN_CAP (miner side; the writer re-enforces)", () => {
    const links = Array.from({ length: FACTS_PER_RUN_CAP + 60 }, (_, i) => `https://wa.me/86138001380${String(i).padStart(2, "0")}`);
    const facts = mineResearchFacts([{ source_type: "website", text: links.join("\n") }]);
    expect(facts).toHaveLength(FACTS_PER_RUN_CAP);
  });

  it("skips empty segments and returns [] for empty input", () => {
    expect(mineResearchFacts([])).toEqual([]);
    expect(mineResearchFacts([{ source_type: "website", text: "" }])).toEqual([]);
    expect(mineResearchFacts([{ source_type: "website", text: "no contact signals here, just words" }])).toEqual([]);
  });
});

describe("hasCurrentResearchFacts (reuse-path gap-fill gate)", () => {
  it("true with a current row, false when only superseded rows exist", async () => {
    const db = makeDb();
    const env = { DB: new FakeD1(db) as any };
    expect(await hasCurrentResearchFacts(env, "comp-1")).toBe(false);
    await appendResearchFacts(env, {
      companyId: "comp-1",
      runId: null,
      facts: [{ fact_type: "email", fact_value: "sales@acme.example", source_type: "backfill" }],
    });
    expect(await hasCurrentResearchFacts(env, "comp-1")).toBe(true);
    db.exec("UPDATE research_facts SET is_current = 0");
    expect(await hasCurrentResearchFacts(env, "comp-1")).toBe(false);
  });

  it("is fail-open on a missing table (reads as no facts)", async () => {
    const db = new DatabaseSync(":memory:");
    await expect(hasCurrentResearchFacts({ DB: new FakeD1(db) as any }, "comp-1")).resolves.toBe(false);
  });
});

describe("pruneSupersededResearchFacts", () => {
  it("prunes only superseded rows past the horizon, current facts survive forever", async () => {
    const db = makeDb();
    db.exec(`
      INSERT INTO research_facts (customer_id, fact_type, fact_value, source_type, fetched_at, is_current, valid_until) VALUES
        ('comp-1', 'email', 'current@acme.example',   'website', '2020-01-01 00:00:00', 1, NULL),
        ('comp-1', 'email', 'superseded@acme.example', 'website', '2020-01-01 00:00:00', 0, '2020-02-01 00:00:00'),
        ('comp-1', 'email', 'recent@acme.example',     'website', '2026-01-01 00:00:00', 0, '2026-10-01 00:00:00'),
        ('comp-1', 'email', 'legacy@acme.example',     'website', '2020-01-01 00:00:00', 0, NULL);
    `);
    const deleted = await pruneSupersededResearchFacts({ DB: new FakeD1(db) as any }, 30, new Date("2026-10-06T00:00:00Z"));
    expect(deleted).toBe(2);
    const kept = rows(db, "SELECT fact_value FROM research_facts ORDER BY id").map((r) => r.fact_value);
    expect(kept).toEqual(["current@acme.example", "recent@acme.example"]);
  });

  it("is fail-open on a missing table (pre-migration window)", async () => {
    const db = new DatabaseSync(":memory:");
    await expect(pruneSupersededResearchFacts({ DB: new FakeD1(db) as any }, 30)).resolves.toBe(0);
  });
});
