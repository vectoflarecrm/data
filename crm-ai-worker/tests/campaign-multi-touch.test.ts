import { describe, it, expect } from "vitest";
import type { AdminEnv } from "../src/admin";
import {
  createCampaign,
  runCampaignGenerate,
  runCampaignSend,
  listCampaignMembers,
  parseSegmentFilters,
  previewSegment,
} from "../src/campaigns";
import type { CampaignDeps, SegmentFilters } from "../src/campaigns";

/* Phase 9 Stage 53 (docs/phase9-contact-multi-touch.md §4-5): multi-touch.
 * A per-person campaign may snapshot up to contacts_per_company (cap 3)
 * email-bearing contacts per company, ranked by the shared role-priority
 * builder. Because several member rows now share one customer_id, every
 * engine write must key on the FULL grain pair — the load-bearing property
 * is independence: one contact's outcome must never mark, unmark or fail
 * its sibling's row.
 *
 * Unlike the Phase 8 fixtures, this file's members table has the
 * post-0028 shape (no explicit PK, contact_norm generated column, grain
 * UNIQUE index) — sibling rows are only insertable after the rebuild. */

/* ── Minimal D1 shim over node:sqlite (campaign-steps pattern) ─────────── */

class FakeD1 {
  constructor(private db: any) {}

  prepare(sql: string) {
    const db = this.db;
    let bound: unknown[] = [];
    return {
      bind(...args: unknown[]) {
        bound = args;
        return this;
      },
      async all<T>() {
        const rows = db.prepare(sql).all(...bound);
        return { results: rows as T[], success: true };
      },
      async first<T>() {
        return (db.prepare(sql).get(...bound) ?? undefined) as T | undefined;
      },
      async run() {
        const info = db.prepare(sql).run(...bound);
        return { success: true, meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) } };
      },
    };
  }

  async batch(stmts: any[]) {
    for (const s of await stmts) await s.run();
    return [];
  }
}

function seedCustomer(id: number, email: string | null, score = 80) {
  return `INSERT INTO customers
    (id, company_id, display_id, domain, status, company_name, country, email,
     customer_segment, product_categories, products_services, lead_score)
    VALUES (${id}, 'c${id}', 'C${id}', 'x${id}.com', 'completed', 'Co ${id}', 'Spain',
            ${email === null ? "NULL" : `'${email}'`}, 'Dealer', 'SUP', NULL, ${score})`;
}

function seedContact(id: number, companyId: string, seq: number, email: string | null, title = "Staff") {
  return `INSERT INTO contacts (id, contact_id, company_id, seq, first_name, title, email)
          VALUES (${id}, 'p${id}', '${companyId}', ${seq}, 'N${id}', '${title}',
                  ${email === null ? "NULL" : `'${email}'`})`;
}

async function makeDb() {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE customers (
      id INTEGER PRIMARY KEY, company_id TEXT, display_id TEXT, domain TEXT, status TEXT,
      company_name TEXT, country TEXT, email TEXT, customer_segment TEXT,
      product_categories TEXT, products_services TEXT, description TEXT,
      business_tag TEXT, lead_score INTEGER
    );
    CREATE TABLE outreach_settings (brand_name TEXT PRIMARY KEY, product_category TEXT, company_intro TEXT,
      enabled INTEGER, sender_email TEXT, sender_name TEXT, gmail_account TEXT);
    CREATE TABLE outreach_emails (
      id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER, company_id TEXT, display_id TEXT,
      company_name TEXT, email_to TEXT, product_category TEXT, brand_name TEXT,
      subject TEXT, body TEXT, status TEXT DEFAULT 'draft', sent_at TEXT, created_at TEXT,
      contact_id INTEGER
    );
    CREATE TABLE outreach_campaigns (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, brand_name TEXT,
      group_id INTEGER, filters TEXT, total INTEGER, status TEXT, auto_advance INTEGER NOT NULL DEFAULT 0, last_error TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
    /* Post-0028 shape: no explicit PK, contact_norm generated, grain UNIQUE. */
    CREATE TABLE outreach_campaign_members (
      campaign_id INTEGER NOT NULL,
      customer_id INTEGER NOT NULL,
      contact_id INTEGER,
      contact_norm INTEGER NOT NULL GENERATED ALWAYS AS (COALESCE(contact_id, 0)) STORED,
      status TEXT NOT NULL DEFAULT 'pending',
      outreach_email_id INTEGER,
      error TEXT
    );
    CREATE INDEX idx_campaign_members_queue ON outreach_campaign_members(campaign_id, status);
    CREATE UNIQUE INDEX idx_campaign_members_grain
      ON outreach_campaign_members(campaign_id, customer_id, contact_norm);
    CREATE TABLE contacts (
      id INTEGER PRIMARY KEY, contact_id TEXT UNIQUE, company_id TEXT, seq INTEGER NOT NULL DEFAULT 1,
      first_name TEXT, last_name TEXT, title TEXT, email TEXT
    );
    INSERT INTO outreach_settings (brand_name, product_category, company_intro, enabled)
      VALUES ('Afarer', 'SUPs', 'A real company intro.', 1);
  `);
  const fake = new FakeD1(db);
  (fake as any).db = db;
  const env = { DB: fake, GMAIL_SEND_DELAY_MS: "0" } as unknown as AdminEnv;
  return { db, env };
}

/* comp_a: contact 11 (采购总监, seq 2) and 12 (销售经理, seq 1) — the role
 * match is at the HIGHER seq, so rank order ≠ seq order. 13 has no email.
 * comp_b: two plain contacts by seq. comp_c: three, seq order 2,3,1. */
function seedCompanies(db: any) {
  db.exec(seedCustomer(1, null));
  db.exec(seedCustomer(2, null));
  db.exec(seedCustomer(3, null));
  db.exec(seedContact(11, "c1", 2, "a11@x.com", "采购总监"));
  db.exec(seedContact(12, "c1", 1, "a12@x.com", "销售经理"));
  db.exec(seedContact(13, "c1", 3, null, "CTO"));
  db.exec(seedContact(21, "c2", 1, "b21@x.com", "Sales"));
  db.exec(seedContact(22, "c2", 2, "b22@x.com", "Engineer"));
  db.exec(seedContact(31, "c3", 2, "c31@x.com", "Ops"));
  db.exec(seedContact(32, "c3", 1, "c32@x.com", "Ops"));
  db.exec(seedContact(33, "c3", 3, "c33@x.com", "Ops"));
}

/* ── Stub writers (campaign-steps pattern, pair-aware) ─────────────────── */

type ContactGenerateFn = CampaignDeps["generateContacts"];
type SendFn = CampaignDeps["send"];

function contactDraftWriter(db: any): ContactGenerateFn {
  return async (_env, _brand, pairs) => {
    const drafts = pairs.map((p) => {
      const r = db
        .prepare(
          "INSERT INTO outreach_emails (customer_id, brand_name, subject, body, status, contact_id) VALUES (?,?,?,?,'draft',?)",
        )
        .run(p.customer_id, "Afarer", "S" + p.contact_id, "B" + p.contact_id, p.contact_id);
      return { customer_id: p.customer_id, contact_id: p.contact_id, email_id: Number(r.lastInsertRowid) };
    });
    return { generated: drafts.length, already: [], drafts, errors: [] };
  };
}

function quotaStub(dailyLimit = 400) {
  const state = { sent: 0, limit: dailyLimit };
  const read = async () => ({
    sent_today: state.sent,
    daily_limit: state.limit,
    remaining: Math.max(0, state.limit - state.sent),
  });
  return Object.assign(read, { state });
}

function membersOf(db: any, campaignId: number): Array<{ customer_id: number; contact_id: number | null; status: string; error: string | null }> {
  return db
    .prepare("SELECT customer_id, contact_id, status, error FROM outreach_campaign_members WHERE campaign_id = ? ORDER BY customer_id, contact_id")
    .all(campaignId) as Array<{ customer_id: number; contact_id: number | null; status: string; error: string | null }>;
}

/* ── contacts_per_company parsing (§4) ─────────────────────────────────── */

describe("contacts_per_company parsing (Phase 9 §4)", () => {
  it("accepts snake_case and camelCase, integers and numeric strings, and round-trips", () => {
    const f = parseSegmentFilters({ per_person: true, contacts_per_company: 2 });
    expect(f.contactsPerCompany).toBe(2);
    expect(parseSegmentFilters({ perPerson: true, contactsPerCompany: "3" }).contactsPerCompany).toBe(3);
    const stored = JSON.parse(JSON.stringify({ contacts_per_company: f.contactsPerCompany })) as { contacts_per_company: number };
    expect(stored.contacts_per_company).toBe(2);
    // Legacy payloads (no key) parse as the Phase 8 default.
    expect(parseSegmentFilters({ per_person: true }).contactsPerCompany).toBe(1);
    expect(parseSegmentFilters({}).contactsPerCompany).toBe(1);
  });

  it("rejects values outside 1-3 and non-integers with an actionable message", () => {
    for (const bad of [0, 4, 2.5, "abc", true]) {
      expect(() => parseSegmentFilters({ contacts_per_company: bad }))
        .toThrow("contacts_per_company 必须是 1-3 之间的整数");
    }
  });
});

/* ── create: top-N snapshot (§4) ───────────────────────────────────────── */

describe("createCampaign: multi-contact snapshot", () => {
  it("snapshots the top-N ranked contacts per company (N=2)", async () => {
    const { db, env } = await makeDb();
    seedCompanies(db);
    const created = await createCampaign(env, {
      brandName: "Afarer",
      filters: parseSegmentFilters({
        per_person: true,
        has_email: false,
        contacts_per_company: 2,
        role_priority: "采购总监,销售经理",
      }),
    });
    expect(created.companies).toBe(3);
    expect(created.total).toBe(6);
    const members = membersOf(db, created.id);
    expect(members).toEqual([
      // comp_a: rank puts 采购总监 (11) first, 销售经理 (12) second;
      // the email-less CTO (13) is never picked.
      { customer_id: 1, contact_id: 11, status: "pending", error: null },
      { customer_id: 1, contact_id: 12, status: "pending", error: null },
      // comp_b: no keyword matches → ELSE rank → seq order 21, 22.
      { customer_id: 2, contact_id: 21, status: "pending", error: null },
      { customer_id: 2, contact_id: 22, status: "pending", error: null },
      // comp_c: seq order picks 32 (seq 1) and 31 (seq 2); rows are listed
      // by contact_id — 33 (seq 3) is out of the N=2 window.
      { customer_id: 3, contact_id: 31, status: "pending", error: null },
      { customer_id: 3, contact_id: 32, status: "pending", error: null },
    ]);
    const row = db.prepare("SELECT filters FROM outreach_campaigns WHERE id = ?").get(created.id) as { filters: string };
    const stored = JSON.parse(row.filters) as { contacts_per_company: number };
    expect(stored.contacts_per_company).toBe(2);
  });

  it("N=3 takes every email-bearing contact and caps at what exists", async () => {
    const { db, env } = await makeDb();
    seedCompanies(db);
    const created = await createCampaign(env, {
      brandName: "Afarer",
      filters: parseSegmentFilters({ per_person: true, has_email: false, contacts_per_company: 3 }),
    });
    const members = membersOf(db, created.id);
    expect(members.filter((m) => m.customer_id === 1).map((m) => m.contact_id)).toEqual([11, 12]);
    expect(members.filter((m) => m.customer_id === 3).map((m) => m.contact_id)).toEqual([31, 32, 33]);
    expect(members).toHaveLength(7);
  });

  it("default N=1 keeps Phase 8 behavior (one row per company, lowest seq)", async () => {
    const { db, env } = await makeDb();
    seedCompanies(db);
    const created = await createCampaign(env, {
      brandName: "Afarer",
      filters: parseSegmentFilters({ per_person: true, has_email: false }),
    });
    expect(created.total).toBe(3);
    const members = membersOf(db, created.id);
    expect(members.map((m) => m.contact_id)).toEqual([12, 21, 32]);
  });

  it("clamps a hand-edited stored value to the server cap of 3", async () => {
    const { db, env } = await makeDb();
    seedCompanies(db);
    // Bypass parse validation the way a hand-edited filters JSON would:
    // createCampaign itself must still refuse to snapshot more than 3.
    const filters = parseSegmentFilters({ per_person: true, has_email: false });
    (filters as SegmentFilters).contactsPerCompany = 99;
    const created = await createCampaign(env, { brandName: "Afarer", filters });
    expect(membersOf(db, created.id).filter((m) => m.customer_id === 3)).toHaveLength(3);
  });

  it("150 家公司的 per-person 群发在 D1 每语句 100 绑定上限内完成（回归：块 100 + N = 101 超限）", async () => {
    const { db } = await makeDb();
    // 150 家公司各 1 个带邮箱联系人 —— 曾用块 100：100 id + 1 个 N 绑定 = 101，
    // 生产 D1（上限 100）直接 "too many SQL variables"，per-person 群发创建失败。
    const parts: string[] = [];
    for (let i = 1; i <= 150; i++) {
      parts.push(seedCustomer(i, null));
      parts.push(seedContact(1000 + i, `c${i}`, 1, `bulk${i}@x.com`));
    }
    db.exec(parts.join("; "));
    // 模拟 D1 硬上限：单条语句绑定参数 > 100 直接抛错（node:sqlite 默认 999，
    // 不模拟则旧代码在本测试照样跑通）。
    const limited = {
      prepare(sql: string) {
        if ((sql.match(/\?/g) ?? []).length > 100) {
          throw new Error("too many SQL variables");
        }
        return db.prepare(sql);
      },
    };
    const fake = new FakeD1(limited as any);
    const env = { DB: fake, GMAIL_SEND_DELAY_MS: "0" } as unknown as AdminEnv;
    const created = await createCampaign(env, {
      brandName: "Afarer",
      filters: parseSegmentFilters({ per_person: true, contacts_per_company: 1 }),
    });
    expect(created.total).toBe(150);
    expect(created.companies).toBe(150);
    const n = db.prepare("SELECT COUNT(*) AS n FROM outreach_campaign_members").get() as { n: number };
    expect(n.n).toBe(150);
  });
});

/* ── generate: per-pair independence (§5, the load-bearing property) ───── */

describe("runCampaignGenerate: per-pair bookkeeping", () => {
  it("drafts every picked contact and keys results by pair", async () => {
    const { db, env } = await makeDb();
    seedCompanies(db);
    const created = await createCampaign(env, {
      brandName: "Afarer",
      filters: parseSegmentFilters({ per_person: true, has_email: false, contacts_per_company: 2 }),
    });
    const r = await runCampaignGenerate(env, created.id, 10, { generateContacts: contactDraftWriter(db) });
    expect(r.generated).toBe(6);
    const members = membersOf(db, created.id);
    expect(members.every((m) => m.status === "generated")).toBe(true);
    // Distinct drafts per sibling, each stamped with its own contact.
    const emails = db
      .prepare("SELECT contact_id FROM outreach_emails WHERE customer_id = 1 ORDER BY contact_id")
      .all() as Array<{ contact_id: number }>;
    expect(emails).toEqual([{ contact_id: 11 }, { contact_id: 12 }]);
    // Results are pair-addressed: same customer appears twice, once per contact.
    const pairResults = r.results.filter((x) => x.customer_id === 1).map((x) => x.contact_id).sort();
    expect(pairResults).toEqual([11, 12]);
  });

  it("an outcome for one contact never touches its sibling's row", async () => {
    const { db, env } = await makeDb();
    seedCompanies(db);
    const created = await createCampaign(env, {
      brandName: "Afarer",
      filters: parseSegmentFilters({ per_person: true, has_email: false, contacts_per_company: 2 }),
    });
    // Drafts every pair EXCEPT (1,12), which hits a terminal error. Under
    // the pre-Phase-9 update (WHERE campaign_id + customer_id) 11's success
    // would have marked 12 'generated' too — that is the bug this pins out.
    const partial: ContactGenerateFn = async (_env, _brand, pairs) => {
      const drafts = [] as Array<{ customer_id: number; contact_id: number; email_id: number }>;
      const errors: Array<{ customer_id: number; contact_id: number; message: string }> = [];
      for (const p of pairs) {
        if (p.customer_id === 1 && p.contact_id === 12) {
          errors.push({ customer_id: 1, contact_id: 12, message: "该联系人没有邮箱" });
          continue;
        }
        const row = db
          .prepare("INSERT INTO outreach_emails (customer_id, brand_name, subject, body, status, contact_id) VALUES (?,?,?,?,'draft',?)")
          .run(p.customer_id, "Afarer", "S" + p.contact_id, "B" + p.contact_id, p.contact_id);
        drafts.push({ customer_id: p.customer_id, contact_id: p.contact_id, email_id: Number(row.lastInsertRowid) });
      }
      return { generated: drafts.length, already: [], drafts, errors };
    };
    const r = await runCampaignGenerate(env, created.id, 10, { generateContacts: partial });
    expect(r.generated).toBe(5);
    expect(r.failed).toBe(1);
    const compA = membersOf(db, created.id).filter((m) => m.customer_id === 1);
    expect(compA).toEqual([
      { customer_id: 1, contact_id: 11, status: "generated", error: null },
      { customer_id: 1, contact_id: 12, status: "failed", error: "该联系人没有邮箱" },
    ]);
  });

  it("a retryable failure on one contact leaves that pair pending, siblings untouched", async () => {
    const { db, env } = await makeDb();
    seedCompanies(db);
    const created = await createCampaign(env, {
      brandName: "Afarer",
      filters: parseSegmentFilters({ per_person: true, has_email: false, contacts_per_company: 2 }),
    });
    const flaky: ContactGenerateFn = async (_env, _brand, pairs) => {
      const drafts = [] as Array<{ customer_id: number; contact_id: number; email_id: number }>;
      const errors: Array<{ customer_id: number; contact_id: number; message: string }> = [];
      for (const p of pairs) {
        if (p.customer_id === 1 && p.contact_id === 11) {
          errors.push({ customer_id: 1, contact_id: 11, message: "429 rate limit" });
        } else {
          const row = db
            .prepare("INSERT INTO outreach_emails (customer_id, brand_name, subject, body, status, contact_id) VALUES (?,?,?,?,'draft',?)")
            .run(p.customer_id, "Afarer", "S" + p.contact_id, "B" + p.contact_id, p.contact_id);
          drafts.push({ customer_id: p.customer_id, contact_id: p.contact_id, email_id: Number(row.lastInsertRowid) });
        }
      }
      return { generated: drafts.length, already: [], drafts, errors };
    };
    await runCampaignGenerate(env, created.id, 10, { generateContacts: flaky });
    const compA = membersOf(db, created.id).filter((m) => m.customer_id === 1);
    expect(compA).toEqual([
      { customer_id: 1, contact_id: 11, status: "pending", error: null },
      { customer_id: 1, contact_id: 12, status: "generated", error: null },
    ]);
  });
});

/* ── send: per-pair member updates (§5) ────────────────────────────────── */

describe("runCampaignSend: per-pair member updates", () => {
  async function seedGeneratedPair(db: any, env: AdminEnv) {
    seedCompanies(db);
    const created = await createCampaign(env, {
      brandName: "Afarer",
      filters: parseSegmentFilters({ per_person: true, has_email: false, contacts_per_company: 2 }),
    });
    await runCampaignGenerate(env, created.id, 10, { generateContacts: contactDraftWriter(db) });
    // Give every draft a distinct envelope so the send stub can single out
    // one sibling for failure.
    db.prepare(
      "UPDATE outreach_emails SET email_to = 'c' || contact_id || '@x.com', subject = 'S', body = 'B' WHERE contact_id IS NOT NULL",
    ).run();
    return created.id;
  }

  it("a failed send marks only that contact's row, keeping the sibling 'sent'", async () => {
    const { db, env } = await makeDb();
    const campaignId = await seedGeneratedPair(db, env);
    const send: SendFn = async (_e, email) => email.email_to === "c12@x.com" ? { ok: false, error: "SMTP rejected" } : { ok: true };
    const r = await runCampaignSend(env, campaignId, 10, { send, quota: quotaStub() });
    expect(r.failed).toBe(1);
    // Pre-Phase-9 the failure UPDATE (WHERE campaign_id + customer_id)
    // would have dragged the already-sent sibling back to 'failed'.
    expect(membersOf(db, campaignId).filter((m) => m.customer_id === 1)).toEqual([
      { customer_id: 1, contact_id: 11, status: "sent", error: null },
      { customer_id: 1, contact_id: 12, status: "failed", error: "SMTP rejected" },
    ]);
  });

  it("a quota stop between siblings leaves the un-sent contact 'generated' for tomorrow", async () => {
    const { db, env } = await makeDb();
    const campaignId = await seedGeneratedPair(db, env);
    const quota = quotaStub(1); // budget for exactly one send
    const r = await runCampaignSend(env, campaignId, 10, {
      send: async () => { quota.state.sent++; return { ok: true }; },
      quota,
    });
    expect(r.quotaStop).toBe(true);
    expect(r.generated).toBe(1);
    const compA = membersOf(db, campaignId).filter((m) => m.customer_id === 1);
    // 11 went out (queue order: customer 1, contact 11 first); 12 must still
    // be waiting with its draft intact — not silently marked 'sent'.
    expect(compA).toEqual([
      { customer_id: 1, contact_id: 11, status: "sent", error: null },
      { customer_id: 1, contact_id: 12, status: "generated", error: null },
    ]);
    const draft12 = db
      .prepare("SELECT status FROM outreach_emails WHERE customer_id = 1 AND contact_id = 12")
      .get() as { status: string };
    expect(draft12.status).toBe("draft");
  });
});

/* ── preview: slots / slots_covered (§5) ───────────────────────────────── */

describe("previewSegment: multi-contact slots", () => {
  it("counts the top-N pick set, not just matched companies", async () => {
    const { db, env } = await makeDb();
    seedCompanies(db);
    const p = await previewSegment(
      env,
      parseSegmentFilters({ per_person: true, has_email: false, contacts_per_company: 2 }),
      "Afarer",
    );
    expect(p.matching).toBe(3); // companies
    expect(p.slots).toBe(6); // 2 + 2 + 2 picked contacts
    expect(p.slots_covered).toBe(0);
  });

  it("slots_covered counts picked contacts that already have an email, per contact", async () => {
    const { db, env } = await makeDb();
    seedCompanies(db);
    // A draft for contact 11 (rank 0 pick) and one for 32 (seq 1 pick) —
    // both inside their companies' top-2 windows.
    db.prepare("INSERT INTO outreach_emails (customer_id, brand_name, status, contact_id) VALUES (1,'Afarer','draft',11)").run();
    db.prepare("INSERT INTO outreach_emails (customer_id, brand_name, status, contact_id) VALUES (3,'Afarer','sent',32)").run();
    // Contact 33 (seq 3, outside comp_c's top-2) — must NOT count.
    db.prepare("INSERT INTO outreach_emails (customer_id, brand_name, status, contact_id) VALUES (3,'Afarer','draft',33)").run();
    const p = await previewSegment(
      env,
      parseSegmentFilters({ per_person: true, has_email: false, contacts_per_company: 2 }),
      "Afarer",
    );
    expect(p.slots).toBe(6);
    expect(p.slots_covered).toBe(2);
  });

  it("company grain mirrors the company numbers (slots = matching, slots_covered = already)", async () => {
    const { db, env } = await makeDb();
    seedCompanies(db);
    db.prepare("UPDATE customers SET email = 'co@x.example' WHERE id = 1").run();
    db.prepare("UPDATE customers SET email = 'co2@x.example' WHERE id = 2").run();
    db.prepare("INSERT INTO outreach_emails (customer_id, brand_name, status, contact_id) VALUES (1,'Afarer','draft',NULL)").run();
    const p = await previewSegment(env, parseSegmentFilters({}), "Afarer");
    expect(p.matching).toBe(2);
    expect(p.already).toBe(1);
    expect(p.slots).toBe(2);
    expect(p.slots_covered).toBe(1);
  });
});

/* ── members listing: deterministic sibling order (§5) ─────────────────── */

describe("listCampaignMembers: sibling ordering", () => {
  it("orders multi-touch rows by customer then contact", async () => {
    const { db, env } = await makeDb();
    seedCompanies(db);
    const created = await createCampaign(env, {
      brandName: "Afarer",
      filters: parseSegmentFilters({ per_person: true, has_email: false, contacts_per_company: 2 }),
    });
    const list = await listCampaignMembers(env, created.id, { limit: 50, offset: 0 });
    expect(list.total).toBe(6);
    const rows = list.items as Array<{ customer_id: number; contact_id: number | null }>;
    expect(rows.map((r) => [r.customer_id, r.contact_id])).toEqual([
      [1, 11], [1, 12],
      [2, 21], [2, 22],
      [3, 31], [3, 32],
    ]);
  });
});
