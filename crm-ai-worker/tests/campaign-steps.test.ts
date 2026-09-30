import { describe, it, expect } from "vitest";
import type { AdminEnv } from "../src/admin";
import {
  createCampaign,
  runCampaignGenerate,
  runCampaignSend,
  setCampaignStatus,
  deleteCampaign,
  listCampaigns,
  getCampaign,
  createGroup,
  listGroups,
  updateGroup,
  deleteGroup,
  parseSegmentFilters,
  previewSegment,
} from "../src/campaigns";
import type { CampaignDeps } from "../src/campaigns";
import { GmailConfigError } from "../src/gmail";

/* These exercise the campaign state machine against a real SQLite engine with
 * a D1-shaped shim. The interesting properties are all about the resume cursor:
 * a member must never be generated twice, sent twice, or lost when a batch
 * stops early — that is what "可续跑" actually guarantees.
 *
 * The AI call and the Gmail call are injected through CampaignDeps, so nothing
 * here spends a token or mails a real person. */

/* ── Minimal D1 shim over node:sqlite ──────────────────────────────────── */

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
        const stmt = db.prepare(sql);
        const rows = stmt.all(...bound);
        return { results: rows as T[], success: true };
      },
      async first<T>() {
        const stmt = db.prepare(sql);
        const row = stmt.get(...bound);
        return (row ?? undefined) as T | undefined;
      },
      async run() {
        const stmt = db.prepare(sql);
        const info = stmt.run(...bound);
        return {
          success: true,
          meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) },
        };
      },
    };
  }

  async batch(stmts: any[]) {
    for (const s of stmts) await s.run();
    return [];
  }
}

const BRANDS = [
  { brand_name: "Afarer", product_category: "SUPs", company_intro: "A real company intro.", enabled: 1 },
];

function seedCustomer(id: number, country: string, email: string | null, score = 80) {
  return `INSERT INTO customers
    (id, company_id, display_id, domain, status, company_name, country, email,
     customer_segment, product_categories, products_services, lead_score)
    VALUES (${id}, 'c${id}', 'C${id}', 'x${id}.com', 'completed', 'Co ${id}', '${country}',
            ${email === null ? "NULL" : `'${email}'`}, 'Dealer', 'SUP', NULL, ${score})`;
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
      subject TEXT, body TEXT, status TEXT DEFAULT 'draft', sent_at TEXT, created_at TEXT
    );
    CREATE TABLE outreach_groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, description TEXT,
      filters TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE outreach_campaigns (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, brand_name TEXT,
      group_id INTEGER, filters TEXT, total INTEGER, status TEXT, last_error TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE outreach_campaign_members (campaign_id INTEGER, customer_id INTEGER, status TEXT,
      outreach_email_id INTEGER, error TEXT, PRIMARY KEY (campaign_id, customer_id));
    CREATE TABLE gmail_send_log (id INTEGER PRIMARY KEY AUTOINCREMENT, outreach_email_id INTEGER,
      recipient TEXT, status TEXT, sent_at TEXT);
  `);
  for (const b of BRANDS) {
    db.prepare(
      "INSERT INTO outreach_settings (brand_name, product_category, company_intro, enabled) VALUES (?,?,?,?)",
    ).run(b.brand_name, b.product_category, b.company_intro, b.enabled);
  }
  const fake = new FakeD1(db);
  // Expose the handle so stubs can insert rows with the same engine.
  (fake as any).db = db;
  // No inter-send throttle in tests; the pacing itself is gmail.ts's business.
  const env = { DB: fake, GMAIL_SEND_DELAY_MS: "0" } as unknown as AdminEnv;
  return { db, env };
}

/* ── Stub generators / senders ──────────────────────────────────────────── */

type GenerateFn = CampaignDeps["generate"];
type SendFn = CampaignDeps["send"];

/* Writes a real draft row per customer id, so the member→email bookkeeping
 * under test is genuinely exercised rather than asserted against a mock. */
function draftWriter(db: any): GenerateFn {
  return async (_env, _brand, ids) => {
    const drafts = ids.map((cid) => {
      const r = db
        .prepare(
          "INSERT INTO outreach_emails (customer_id, brand_name, subject, body, status) VALUES (?,?,?,?,'draft')",
        )
        .run(cid, "Afarer", "S" + cid, "B" + cid);
      return { customer_id: cid, email_id: Number(r.lastInsertRowid) };
    });
    return { generated: drafts.length, already: [], drafts, errors: [] };
  };
}

/* Mirrors the real generator's dedupe path: a customer who already has an
 * email for this brand is adopted, never given a second one. */
function adoptingWriter(db: any): GenerateFn {
  return async (_env, _brand, ids) => {
    const already = ids.flatMap((cid) => {
      const row = db
        .prepare("SELECT id, status FROM outreach_emails WHERE customer_id = ? AND brand_name = ? ORDER BY id LIMIT 1")
        .get(cid, "Afarer") as { id: number; status: string } | undefined;
      return row ? [{ customer_id: cid, email_id: row.id, status: row.status }] : [];
    });
    return { generated: 0, already, drafts: [], errors: [] };
  };
}

/* A generator that produces no draft for anybody, and reports a message for
 * each customer so the retry-vs-fail classification is actually exercised. */
function failingWriter(message: (cid: number) => string): GenerateFn {
  return async (_env, _brand, ids) => ({
    generated: 0,
    already: [],
    drafts: [],
    errors: ids.map((cid) => ({ customer_id: cid, message: message(cid) })),
  });
}

const genOK = (db: any): Partial<CampaignDeps> => ({ generate: draftWriter(db) });

/* A quota reader the test controls by hand. `state.sent` is bumped by
 * `sendOK`/`sendFail` so the pre-send budget check sees a moving target. */
function quotaStub(dailyLimit = 400) {
  const state = { sent: 0, limit: dailyLimit };
  const read = async () => ({
    sent_today: state.sent,
    daily_limit: state.limit,
    remaining: Math.max(0, state.limit - state.sent),
  });
  return Object.assign(read, { state });
}

const sendOK = (quota: ReturnType<typeof quotaStub>): SendFn => async () => {
  quota.state.sent++;
  return { ok: true };
};
const sendFail = (error: string): SendFn => async () => ({ ok: false, error });

const genDeps = (generate: GenerateFn): Partial<CampaignDeps> => ({ generate });
const sendDeps = (send: SendFn, quota = quotaStub()): Partial<CampaignDeps> => ({ send, quota });

/* ── Group CRUD ────────────────────────────────────────────────────────── */

describe("saved groups (客群)", () => {
  it("creates, lists, updates and deletes a group", async () => {
    const { env } = await makeDb();
    const id = await createGroup(env, {
      name: "西班牙经销商",
      description: "Spain dealers",
      filters: { countries: "Spain", segments: "Dealer" },
    });
    expect(id).toBeGreaterThan(0);

    const list = await listGroups(env);
    expect(list).toHaveLength(1);
    expect(JSON.parse(list[0].filters).countries).toEqual(["Spain"]);

    await updateGroup(env, id, { name: "西语经销商" });
    expect((await listGroups(env))[0].name).toBe("西语经销商");

    await deleteGroup(env, id);
    expect(await listGroups(env)).toHaveLength(0);
  });

  it("rejects a duplicate name with an actionable message", async () => {
    const { env } = await makeDb();
    await createGroup(env, { name: "A", filters: {} });
    await expect(createGroup(env, { name: "A", filters: {} })).rejects.toThrow(/已存在/);
  });

  it("rejects an empty name and a non-object filter payload", async () => {
    const { env } = await makeDb();
    await expect(createGroup(env, { name: "  ", filters: {} })).rejects.toThrow(/不能为空/);
    await expect(createGroup(env, { name: "B", filters: "nope" })).rejects.toThrow(/JSON 对象/);
  });

  it("rejects an update with no fields", async () => {
    const { env } = await makeDb();
    const id = await createGroup(env, { name: "A", filters: {} });
    await expect(updateGroup(env, id, {})).rejects.toThrow(/没有需要更新/);
  });
});

/* ── Preview ───────────────────────────────────────────────────────────── */

describe("previewSegment", () => {
  it("reports matches, pre-existing drafts and the country rollup", async () => {
    const { db, env } = await makeDb();
    db.exec(seedCustomer(1, "Spain", "a@x.com"));
    db.exec(seedCustomer(2, "Spain", "b@x.com"));
    db.exec(seedCustomer(3, "France", "c@x.com"));
    db.exec("INSERT INTO outreach_emails (customer_id, brand_name, status) VALUES (2,'Afarer','draft')");

    const p = await previewSegment(env, parseSegmentFilters({}), "Afarer");
    expect(p.matching).toBe(3);
    expect(p.already).toBe(1);
    expect(p.pending).toBe(2);
    expect(p.sample.find((s) => s.id === 2)?.has_draft).toBe(1);
    expect(p.by_country.find((c) => c.country === "Spain")?.n).toBe(2);
  });

  it("excludes already-sent customers for the brand when asked", async () => {
    const { db, env } = await makeDb();
    db.exec(seedCustomer(1, "Spain", "a@x.com"));
    db.exec(seedCustomer(2, "Spain", "b@x.com"));
    db.exec("INSERT INTO outreach_emails (customer_id, brand_name, status) VALUES (2,'Afarer','sent')");

    const on = await previewSegment(env, parseSegmentFilters({}), "Afarer");
    expect(on.matching).toBe(1);
    const off = await previewSegment(env, parseSegmentFilters({ exclude_sent: false }), "Afarer");
    expect(off.matching).toBe(2);
  });
});

/* ── Campaign creation ─────────────────────────────────────────────────── */

describe("createCampaign", () => {
  it("snapshots matching customers and the filter set", async () => {
    const { db, env } = await makeDb();
    db.exec(seedCustomer(1, "Spain", "a@x.com"));
    db.exec(seedCustomer(2, "Spain", "b@x.com"));
    db.exec(seedCustomer(3, "France", "c@x.com"));

    const created = await createCampaign(env, {
      brandName: "Afarer",
      filters: parseSegmentFilters({ countries: "Spain" }),
    });
    expect(created.total).toBe(2);
    expect(created.capped).toBe(false);

    const campaign = (await listCampaigns(env))[0];
    expect(campaign.total).toBe(2);
    expect(campaign.pending).toBe(2);
    expect(campaign.remaining).toBe(2);
    expect(campaign.done).toBe(false);
  });

  it("snapshots ids, so later customer churn cannot change the audience", async () => {
    const { db, env } = await makeDb();
    db.exec(seedCustomer(1, "Spain", "a@x.com"));
    db.exec(seedCustomer(2, "Spain", "b@x.com"));
    const created = await createCampaign(env, { brandName: "Afarer", filters: parseSegmentFilters({}) });
    expect(created.total).toBe(2);

    // The research pipeline keeps mutating `customers` between clicks; the
    // audience must be frozen at creation or "previewed N" and "emailed N"
    // would silently disagree.
    db.exec("UPDATE customers SET country = 'Brazil'");
    const c = await getCampaign(env, created.id);
    expect(c!.total).toBe(2);
    const members = db.prepare("SELECT customer_id FROM outreach_campaign_members ORDER BY customer_id").all();
    expect(members).toEqual([{ customer_id: 1 }, { customer_id: 2 }]);
  });

  it("names the campaign from the group when no name is given", async () => {
    const { db, env } = await makeDb();
    db.exec(seedCustomer(1, "Spain", "a@x.com"));
    const gid = await createGroup(env, { name: "西班牙经销商", filters: { countries: "Spain" } });
    const created = await createCampaign(env, {
      brandName: "Afarer",
      groupId: gid,
      filters: parseSegmentFilters({ countries: "Spain" }),
      groupName: "西班牙经销商",
    });
    const list = await listCampaigns(env);
    expect(list[0].name).toBe("西班牙经销商");
    expect(list[0].group_id).toBe(gid);
    expect(created.total).toBe(1);
  });

  it("refuses a brand that is missing, disabled or unconfigured", async () => {
    const { db, env } = await makeDb();
    db.exec(seedCustomer(1, "Spain", "a@x.com"));
    const filters = parseSegmentFilters({});

    await expect(createCampaign(env, { brandName: "Nope", filters })).rejects.toThrow(/不存在/);

    db.exec("UPDATE outreach_settings SET enabled = 0 WHERE brand_name = 'Afarer'");
    await expect(createCampaign(env, { brandName: "Afarer", filters })).rejects.toThrow(/未启用/);

    db.exec("UPDATE outreach_settings SET enabled = 1, company_intro = '[待填写]' WHERE brand_name = 'Afarer'");
    await expect(createCampaign(env, { brandName: "Afarer", filters })).rejects.toThrow(/尚未配置/);
  });

  it("refuses to create an empty campaign", async () => {
    const { env } = await makeDb();
    await expect(
      createCampaign(env, { brandName: "Afarer", filters: parseSegmentFilters({}) }),
    ).rejects.toThrow(/没有匹配/);
  });

  it("excludes customers with no email, since they cannot be mailed", async () => {
    const { db, env } = await makeDb();
    db.exec(seedCustomer(1, "Spain", "a@x.com"));
    db.exec(seedCustomer(2, "Spain", null));
    const created = await createCampaign(env, { brandName: "Afarer", filters: parseSegmentFilters({}) });
    expect(created.total).toBe(1);
  });
});

/* ── Generation step ───────────────────────────────────────────────────── */

describe("runCampaignGenerate", () => {
  it("generates drafts and advances members pending → generated", async () => {
    const { db, env } = await makeDb();
    db.exec(seedCustomer(1, "Spain", "a@x.com"));
    db.exec(seedCustomer(2, "Spain", "b@x.com"));
    await createCampaign(env, { brandName: "Afarer", filters: parseSegmentFilters({}) });
    const id = (await listCampaigns(env))[0].id;

    const r = await runCampaignGenerate(env, id, 10, genOK(db));

    expect(r.generated).toBe(2);
    expect(r.processed).toBe(2);
    // The generation step is finished...
    expect(r.done).toBe(true);
    const c = await getCampaign(env, id);
    expect(c!.generated).toBe(2);
    expect(c!.pending).toBe(0);
    // ...but the campaign is not: 2 drafts are still waiting to go out.
    expect(c!.done).toBe(false);
    expect(c!.remaining).toBe(2);
  });

  it("processes one batch at a time and resumes from the cursor", async () => {
    const { db, env } = await makeDb();
    for (let i = 1; i <= 5; i++) db.exec(seedCustomer(i, "Spain", `u${i}@x.com`));
    await createCampaign(env, { brandName: "Afarer", filters: parseSegmentFilters({}) });
    const id = (await listCampaigns(env))[0].id;

    const generate = draftWriter(db);
    const deps = genDeps(generate);

    const first = await runCampaignGenerate(env, id, 2, deps);
    expect(first.generated).toBe(2);
    expect(first.done).toBe(false);

    const second = await runCampaignGenerate(env, id, 2, deps);
    expect(second.generated).toBe(2);

    const third = await runCampaignGenerate(env, id, 2, deps);
    expect(third.generated).toBe(1);
    expect(third.done).toBe(true);

    // Every member generated exactly once, and no member processed twice.
    const rows = db.prepare("SELECT status, COUNT(*) n FROM outreach_campaign_members GROUP BY status").all();
    expect(rows).toEqual([{ status: "generated", n: 5 }]);
    const drafts = db.prepare("SELECT COUNT(*) n FROM outreach_emails").get() as { n: number };
    expect(drafts.n).toBe(5);
  });

  it("adopts an existing draft for the brand instead of generating a second one", async () => {
    const { db, env } = await makeDb();
    db.exec(seedCustomer(1, "Spain", "a@x.com"));
    db.exec("INSERT INTO outreach_emails (customer_id, brand_name, subject, body, status) VALUES (1,'Afarer','old','old','draft')");
    await createCampaign(env, { brandName: "Afarer", filters: parseSegmentFilters({ exclude_sent: false }) });
    const id = (await listCampaigns(env))[0].id;

    const r = await runCampaignGenerate(env, id, 10, { generate: adoptingWriter(db) });
    expect(r.generated).toBe(0);
    expect(r.skipped).toBe(1);
    const c = await getCampaign(env, id);
    expect(c!.generated).toBe(1);
    const emails = db.prepare("SELECT COUNT(*) n FROM outreach_emails").get() as { n: number };
    expect(emails.n).toBe(1);
  });

  it("keeps a member queued when the AI provider is rate-limited, and retries it later", async () => {
    const { db, env } = await makeDb();
    db.exec(seedCustomer(1, "Spain", "a@x.com"));
    db.exec(seedCustomer(2, "Spain", "b@x.com"));
    await createCampaign(env, { brandName: "Afarer", filters: parseSegmentFilters({}) });
    const id = (await listCampaigns(env))[0].id;

    const first = await runCampaignGenerate(env, id, 10, {
      generate: failingWriter(() => "HTTP 429 rate limit"),
    });
    expect(first.failed).toBe(0);

    // Both members stay 'pending', so a retry can still pick them up.
    const c = await getCampaign(env, id);
    expect(c!.pending).toBe(2);
    expect(c!.failed).toBe(0);
    expect(c!.remaining).toBe(2);
    expect(c!.last_error).toMatch(/暂时不可用/);

    // A later click succeeds and they advance.
    const retry = await runCampaignGenerate(env, id, 10, genOK(db));
    expect(retry.generated).toBe(2);
    expect((await getCampaign(env, id))!.last_error).toBeNull();
  });

  it("marks a terminal per-customer failure as failed so the campaign can finish", async () => {
    const { db, env } = await makeDb();
    db.exec(seedCustomer(1, "Spain", "a@x.com"));
    await createCampaign(env, { brandName: "Afarer", filters: parseSegmentFilters({}) });
    const id = (await listCampaigns(env))[0].id;

    const r = await runCampaignGenerate(env, id, 10, {
      generate: failingWriter(() => "AI returned empty"),
    });
    expect(r.failed).toBe(1);
    const c = await getCampaign(env, id);
    expect(c!.failed).toBe(1);
    expect(c!.done).toBe(true);
  });

  it("is a no-op once every member has been generated", async () => {
    const { db, env } = await makeDb();
    db.exec(seedCustomer(1, "Spain", "a@x.com"));
    await createCampaign(env, { brandName: "Afarer", filters: parseSegmentFilters({}) });
    const id = (await listCampaigns(env))[0].id;

    const deps = genOK(db);
    await runCampaignGenerate(env, id, 10, deps);
    const again = await runCampaignGenerate(env, id, 10, deps);
    expect(again.processed).toBe(0);
    expect(again.done).toBe(true);
  });

  it("refuses to run while the campaign is paused", async () => {
    const { db, env } = await makeDb();
    db.exec(seedCustomer(1, "Spain", "a@x.com"));
    await createCampaign(env, { brandName: "Afarer", filters: parseSegmentFilters({}) });
    const id = (await listCampaigns(env))[0].id;
    await setCampaignStatus(env, id, "paused");
    // A mis-targeted bulk mail needs a hard stop, not a warning.
    await expect(runCampaignGenerate(env, id, 10, genOK(db))).rejects.toThrow(/已暂停/);
  });
});

/* ── Send step ─────────────────────────────────────────────────────────── */

describe("runCampaignSend", () => {
  async function campaignWithDrafts(n: number) {
    const { db, env } = await makeDb();
    for (let i = 1; i <= n; i++) db.exec(seedCustomer(i, "Spain", `u${i}@x.com`));
    await createCampaign(env, { brandName: "Afarer", filters: parseSegmentFilters({}) });
    const id = (await listCampaigns(env))[0].id;
    await runCampaignGenerate(env, id, 50, genOK(db));
    return { db, env, id };
  }

  it("sends a batch and marks those members sent", async () => {
    const { env, id } = await campaignWithDrafts(4);

    const sentIds: number[] = [];
    const quota = quotaStub();
    const r = await runCampaignSend(env, id, 2, {
      quota,
      send: async (_env, email) => { sentIds.push(email.id); return { ok: true }; },
    });

    expect(r.generated).toBe(2);
    expect(sentIds).toHaveLength(2);
    const c = await getCampaign(env, id);
    expect(c!.sent).toBe(2);
    expect(c!.generated).toBe(2);
    expect(c!.done).toBe(false);
  });

  it("never re-sends a member across batches", async () => {
    const { env, id } = await campaignWithDrafts(3);
    const sentIds: number[] = [];
    const deps = sendDeps(async (_env, email) => { sentIds.push(email.id); return { ok: true }; });

    await runCampaignSend(env, id, 1, deps);
    await runCampaignSend(env, id, 1, deps);
    await runCampaignSend(env, id, 1, deps);
    const after = await runCampaignSend(env, id, 1, deps);

    expect(sentIds).toHaveLength(3);
    expect(new Set(sentIds).size).toBe(3);
    expect(after.done).toBe(true);
    const c = await getCampaign(env, id);
    expect(c!.sent).toBe(3);
    expect(c!.remaining).toBe(0);
  });

  it("stops the batch at the daily quota without burning anyone as failed", async () => {
    const { env, id } = await campaignWithDrafts(5);
    // Only 2 of today's 400 slots are left.
    const quota = quotaStub(2);
    const r = await runCampaignSend(env, id, 5, sendDeps(sendOK(quota), quota));

    expect(r.quotaStop).toBe(true);
    expect(r.generated).toBe(2);
    expect(r.failed).toBe(0);
    const c = await getCampaign(env, id);
    // The crucial part: nobody is recorded as 'failed'. All 3 unsent members
    // stay 'generated' and will go out tomorrow.
    expect(c!.failed).toBe(0);
    expect(c!.generated).toBe(3);
    expect(c!.sent).toBe(2);
    expect(c!.remaining).toBe(3);
  });

  it("treats a mid-batch quota throw as a stop, not a per-recipient failure", async () => {
    const { env, id } = await campaignWithDrafts(3);
    let allowance = 2;
    const quota = quotaStub();
    const r = await runCampaignSend(env, id, 3, {
      quota,
      send: async () => {
        if (allowance <= 0) {
          // Mirrors assertQuota() throwing once the budget is gone.
          throw new Error("今日 Gmail 发送配额已用完（400 封/天），明天再试");
        }
        allowance--;
        return { ok: true };
      },
    });

    expect(r.quotaStop).toBe(true);
    expect(r.generated).toBe(2);
    expect(r.failed).toBe(0);
    const c = await getCampaign(env, id);
    expect(c!.failed).toBe(0);
    expect(c!.generated).toBe(1);
    expect(c!.sent).toBe(2);
  });

  it("aborts the batch on a Gmail configuration error instead of failing everyone", async () => {
    const { env, id } = await campaignWithDrafts(3);
    const r = await runCampaignSend(env, id, 3, {
      quota: quotaStub(),
      send: async () => { throw new GmailConfigError("Gmail 未配置"); },
    });

    expect(r.failed).toBe(1);
    // Missing config fails identically for everyone, so the rest stay queued.
    const c = await getCampaign(env, id);
    expect(c!.failed).toBe(1);
    expect(c!.generated).toBe(2);
    expect(c!.last_error).toMatch(/配置/);
  });

  it("records a real per-recipient failure as failed", async () => {
    const { db, env, id } = await campaignWithDrafts(2);
    const r = await runCampaignSend(env, id, 2, sendDeps(sendFail("HTTP 550 mailbox unavailable")));

    expect(r.failed).toBe(2);
    const c = await getCampaign(env, id);
    expect(c!.failed).toBe(2);
    expect(c!.done).toBe(true);
    const row = db
      .prepare("SELECT error FROM outreach_campaign_members LIMIT 1")
      .get() as { error: string };
    expect(row.error).toMatch(/550/);
  });

  it("clears a stale error banner once a later batch goes out cleanly", async () => {
    const { db, env, id } = await campaignWithDrafts(2);
    const bad = await runCampaignSend(env, id, 2, sendDeps(sendFail("HTTP 421 mailbox busy")));
    expect(bad.failed).toBe(2);
    expect((await getCampaign(env, id))!.last_error).toMatch(/421/);

    // Those recipients are terminal, so generate a fresh set of drafts to
    // prove a clean pass wipes the banner instead of leaving it forever.
    await runCampaignGenerate(env, id, 50, genOK(db));
    const ok = await runCampaignSend(env, id, 2, sendDeps(async () => ({ ok: true })));
    expect(ok.failed).toBe(0);
    expect((await getCampaign(env, id))!.last_error).toBeNull();
  });

  it("refuses to run while the campaign is paused", async () => {
    const { env, id } = await campaignWithDrafts(1);
    await setCampaignStatus(env, id, "paused");
    await expect(runCampaignSend(env, id, 5, sendDeps(async () => ({ ok: true })))).rejects.toThrow(/已暂停/);
  });

  it("is a no-op when there is nothing left to send", async () => {
    const { env, id } = await campaignWithDrafts(1);
    const deps = sendDeps(async () => ({ ok: true }));
    await runCampaignSend(env, id, 5, deps);
    const again = await runCampaignSend(env, id, 5, deps);
    expect(again.processed).toBe(0);
    expect(again.done).toBe(true);
  });
});

/* ── Deletion ──────────────────────────────────────────────────────────── */

describe("deleteCampaign", () => {
  it("removes the campaign and its members but keeps generated drafts", async () => {
    const { db, env } = await makeDb();
    db.exec(seedCustomer(1, "Spain", "a@x.com"));
    await createCampaign(env, { brandName: "Afarer", filters: parseSegmentFilters({}) });
    const id = (await listCampaigns(env))[0].id;
    db.exec("INSERT INTO outreach_emails (customer_id, brand_name, subject, body, status) VALUES (1,'Afarer','S','B','draft')");

    await deleteCampaign(env, id);
    expect(await listCampaigns(env)).toHaveLength(0);
    const members = db.prepare("SELECT COUNT(*) n FROM outreach_campaign_members").get() as { n: number };
    expect(members.n).toBe(0);
    const emails = db.prepare("SELECT COUNT(*) n FROM outreach_emails").get() as { n: number };
    expect(emails.n).toBe(1);
  });

  it("errors on an unknown campaign id", async () => {
    const { env } = await makeDb();
    await expect(runCampaignSend(env, 999, 5, sendDeps(async () => ({ ok: true })))).rejects.toThrow(/不存在/);
  });
});
