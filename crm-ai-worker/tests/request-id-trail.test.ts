import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { runCampaignGenerate, runCampaignSend, type CampaignDeps } from "../src/campaigns";
import type { AdminEnv } from "../src/admin";
import { makeDb, makeEnv, bearer, call } from "./security/_helpers";

/* Post-V2 Stage 33 — per-row request_id on business tables.
 *
 * The chain being shortened: an admin request's UUID (X-Request-ID header,
 * audit_logs.request_id) now also lands on the business event rows that
 * request produced (outreach_emails drafts, gmail_send_log attempts,
 * customer_imports rows) — one hop from any row to its request, instead of
 * joining through audit metadata.
 *
 * What is testable without the real AI/Gmail transports (both are
 * dependency-injected in production seams): the THREADING — the id minted in
 * handleAdminRequest must reach the exact INSERT call sites — plus the real
 * import path end to end (no external dependency), including the audit ↔
 * business row alignment that IS the shortened chain.
 */

/* ── Campaign threading (deps injection) ─────────────────────────────────── */

class FakeD1 {
  constructor(public db: any) {}
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

const CAMPAIGN_SCHEMA = `
  CREATE TABLE customers (id INTEGER PRIMARY KEY, company_id TEXT, display_id TEXT, domain TEXT,
    status TEXT, company_name TEXT, country TEXT, email TEXT);
  CREATE TABLE outreach_settings (brand_name TEXT PRIMARY KEY, product_category TEXT, company_intro TEXT,
    enabled INTEGER, sender_email TEXT, sender_name TEXT, gmail_account TEXT);
  CREATE TABLE outreach_emails (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER, company_id TEXT,
    display_id TEXT, company_name TEXT, email_to TEXT, product_category TEXT, brand_name TEXT,
    subject TEXT, body TEXT, status TEXT DEFAULT 'draft', sent_at TEXT, created_at TEXT);
  CREATE TABLE outreach_campaigns (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, brand_name TEXT,
    group_id INTEGER, filters TEXT, total INTEGER, status TEXT, last_error TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE outreach_campaign_members (campaign_id INTEGER, customer_id INTEGER, contact_id INTEGER, status TEXT,
    outreach_email_id INTEGER, error TEXT, PRIMARY KEY (campaign_id, customer_id));
`;

function campaignDb(): any {
  const db = new DatabaseSync(":memory:");
  db.exec(CAMPAIGN_SCHEMA);
  db.prepare("INSERT INTO outreach_settings (brand_name, product_category, company_intro, enabled) VALUES ('Afarer','SUPs','intro',1)").run();
  db.prepare("INSERT INTO outreach_campaigns (id, name, brand_name, status) VALUES (1, 't', 'Afarer', 'draft')").run();
  return db;
}

function campaignEnv(db: any): AdminEnv {
  return { DB: new FakeD1(db), GMAIL_SEND_DELAY_MS: "0" } as unknown as AdminEnv;
}

describe("stage 33: request_id threading through the campaign seams", () => {
  it("runCampaignGenerate forwards the request id to the generator", async () => {
    const db = campaignDb();
    db.prepare("INSERT INTO outreach_campaign_members (campaign_id, customer_id, status) VALUES (1, 1, 'pending')").run();
    const seen: Array<unknown> = [];
    const generate = (async (_env, _brand, ids, requestId) => {
      seen.push({ ids, requestId });
      return { generated: 0, already: [], drafts: [], errors: [] };
    }) as CampaignDeps["generate"];
    await runCampaignGenerate(campaignEnv(db), 1, 10, { generate }, "req-gen-1");
    expect(seen).toEqual([{ ids: [1], requestId: "req-gen-1" }]);
  });

  it("runCampaignGenerate stays backward compatible when no id is passed", async () => {
    const db = campaignDb();
    db.prepare("INSERT INTO outreach_campaign_members (campaign_id, customer_id, status) VALUES (1, 1, 'pending')").run();
    const seen: Array<unknown> = [];
    const generate = (async (_env, _brand, _ids, requestId) => {
      seen.push(requestId);
      return { generated: 0, already: [], drafts: [], errors: [] };
    }) as CampaignDeps["generate"];
    await runCampaignGenerate(campaignEnv(db), 1, 10, { generate });
    expect(seen).toEqual([null]);
  });

  it("runCampaignSend forwards the request id into the transport options", async () => {
    const db = campaignDb();
    db.prepare("INSERT INTO outreach_emails (customer_id, email_to, subject, body, status) VALUES (1, 'a@b.c', 'S', 'B', 'draft')").run();
    db.prepare("INSERT INTO outreach_campaign_members (campaign_id, customer_id, status, outreach_email_id) VALUES (1, 1, 'generated', 1)").run();
    const seenOptions: Array<unknown> = [];
    const send = (async (_env, _email, options) => {
      seenOptions.push(options?.requestId);
      return { ok: true, gmail_message_id: "gm-1" };
    }) as CampaignDeps["send"];
    const quota = (async () => ({ sent_today: 0, daily_limit: 400, remaining: 400 })) as CampaignDeps["quota"];
    const result = await runCampaignSend(campaignEnv(db), 1, 10, { send, quota }, "req-send-1");
    expect(result.generated).toBe(1);
    expect(seenOptions).toEqual(["req-send-1"]);
  });
});

/* ── Real import path end to end ─────────────────────────────────────────── */

describe("stage 33: import rows carry the producing request's id", () => {
  it("customer_imports.request_id === X-Request-ID === the IMPORT_CSV audit row's id", async () => {
    const db = makeDb();
    const env = makeEnv(db);
    // A pre-existing customer on acme.com: the import's first row maps to it
    // (dedup happens against what is already IN the database — rows of the
    // same batch are inserted, not deduped against each other).
    db.prepare(
      "INSERT INTO customers (company_id, domain, normalized_domain, company_name, status) VALUES ('c_seed', 'acme.com', 'acme.com', 'Acme Old', 'completed')",
    ).run();
    const res = await call(env, "/admin/api/customers/import", {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({
        file_name: "leads.csv",
        csv: "company_name,domain,country\nAcme GmbH,acme.com,Germany\nNew Co,newco.com,Spain\nThird Co,third.io,Italy",
      }),
    });
    expect(res.status).toBe(200);
    const requestId = res.headers.get("X-Request-ID");
    expect(requestId).toBeTruthy();

    // One matched (existing) + two inserted rows, ALL stamped with the id.
    const rows = db.prepare("SELECT dedup_status, request_id FROM customer_imports ORDER BY id").all() as Array<{ dedup_status: string; request_id: string | null }>;
    expect(rows.map((r) => r.dedup_status)).toEqual(["matched", "inserted", "inserted"]);
    expect(rows.every((r) => r.request_id === requestId)).toBe(true);

    // THE shortened chain: the business row and the request's audit row
    // share the same id in one hop.
    const audit = db.prepare("SELECT request_id FROM audit_logs WHERE action = 'IMPORT_CSV'").get() as { request_id: string | null };
    expect(audit.request_id).toBe(requestId);
  });

  it("customers imported by that request are traceable through their import row", async () => {
    const db = makeDb();
    const env = makeEnv(db);
    const res = await call(env, "/admin/api/customers/import", {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({
        file_name: "one.csv",
        csv: "company_name,domain\nSolo Ltd,solo.io",
      }),
    });
    expect(res.status).toBe(200);
    const requestId = res.headers.get("X-Request-ID");
    // The customer row itself carries source_import_id; the import row now
    // carries request_id — customer → import row → request in two hops.
    const joined = db.prepare(
      `SELECT c.company_id, i.request_id FROM customers c
       JOIN customer_imports i ON i.mapped_company_id = c.company_id
       WHERE c.source_import_id IS NOT NULL`,
    ).get() as { company_id: string; request_id: string | null };
    expect(joined.request_id).toBe(requestId);
    expect(joined.company_id).toBeTruthy();
  });
});
