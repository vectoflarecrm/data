import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { AdminEnv } from "../src/admin";
import { handleAdminRequest } from "../src/admin";
import type { GmailEnv } from "../src/gmail";
import { acquireCampaignLock, CampaignLockedError } from "../src/campaign-lock";
import { runCampaignSend, runCampaignGenerate } from "../src/campaigns";
import { sendWithStateMachine } from "../src/outreach-send";

/* Security V2 Stage 12 — campaign concurrency lock (spec §13).
 *
 * §13.2 test list, mapped:
 *   10 workers sending the same campaign ✓ (with the lock: single-flight;
 *   without the table: fail-open, per-email claims still hold)
 *   each member claimed by at most one worker ✓
 *   each email sent at most once ✓
 * Layering: the lock is defense in depth over Stage 10's per-email atomic
 * claims — the fail-open test proves the "at most once" guarantee does not
 * depend on this stage, only the "no duplicated work" guarantee does.
 */

const TOKEN = "campaign-lock-master-token";
const BASE = "https://worker.example";

function sqlUtc(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
  );
}

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

/** Same state-machine schema as outreach-send.test.ts, WITHOUT campaign_locks:
 * the base fixture doubles as the "migration pending" case. */
function makeDb(): any {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE outreach_emails (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER, company_id TEXT, display_id TEXT, company_name TEXT,
      email_to TEXT, product_category TEXT, brand_name TEXT,
      subject TEXT, body TEXT, status TEXT DEFAULT 'draft', sent_at TIMESTAMP,
      idempotency_key TEXT, send_attempts INTEGER NOT NULL DEFAULT 0,
      locked_at TEXT, locked_by TEXT, last_error TEXT, gmail_message_id TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX idx_outreach_idempotency
      ON outreach_emails(idempotency_key) WHERE idempotency_key IS NOT NULL;
    CREATE INDEX idx_outreach_send_lock ON outreach_emails(status, locked_at);
    CREATE TABLE outreach_campaign_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL, customer_id INTEGER NOT NULL,
      contact_id INTEGER, outreach_email_id INTEGER, status TEXT NOT NULL DEFAULT 'pending',
      error TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE outreach_campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, brand_name TEXT,
      group_id INTEGER, filters TEXT, total INTEGER, status TEXT,
      last_error TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE outreach_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT, brand_name TEXT NOT NULL UNIQUE,
      product_category TEXT NOT NULL, sender_email TEXT, sender_name TEXT,
      company_entity TEXT, signature TEXT, gmail_account TEXT,
      enabled INTEGER DEFAULT 0, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE customers (id INTEGER PRIMARY KEY, company_id TEXT, status TEXT, country TEXT);
  `);
  return db;
}

function withLocks(db: any): any {
  db.exec(`
    CREATE TABLE campaign_locks (
      campaign_id INTEGER PRIMARY KEY,
      lock_token TEXT NOT NULL,
      locked_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
  `);
  return db;
}

function withAdminTables(db: any): any {
  db.exec(`
    CREATE TABLE gmail_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT, credential_type TEXT,
      client_email TEXT NOT NULL UNIQUE, private_key TEXT NOT NULL,
      delegated_domain TEXT, daily_limit INTEGER, enabled INTEGER NOT NULL DEFAULT 1,
      last_error TEXT, cooldown_until TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE gmail_send_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, outreach_email_id INTEGER,
      recipient TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'sent',
      detail TEXT, sender_client_email TEXT,
      sent_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE audit_logs (
      id TEXT PRIMARY KEY, actor_user_id TEXT, actor_role TEXT, action TEXT NOT NULL,
      resource_type TEXT NOT NULL, resource_id TEXT, request_id TEXT,
      metadata_json TEXT, ip_hash TEXT, user_agent_hash TEXT, created_at TEXT NOT NULL
    );
  `);
  return db;
}

function makeEnv(db: any, overrides: Record<string, unknown> = {}): AdminEnv {
  return { DB: new FakeD1(db), ...overrides } as unknown as AdminEnv;
}

function insertEmail(db: any, customerId: number): number {
  const info = db.prepare(
    `INSERT INTO outreach_emails (customer_id, email_to, subject, body, status)
     VALUES (?, ?, ?, ?, 'draft')`,
  ).run(customerId, `buyer${customerId}@acme.com`, "Offer", "Hello, we supply parts.");
  return Number(info.lastInsertRowid);
}

/** Campaign with the given member statuses; every non-pending member gets a
 * draft email, mirroring the state after the generate step. */
function seedCampaign(db: any, memberStatuses: string[]): number {
  db.prepare(
    `INSERT INTO outreach_campaigns (name, brand_name, group_id, filters, total, status)
     VALUES ('Q4 push', 'Afarer', 1, '{}', ?, 'sending')`,
  ).run(memberStatuses.length);
  const campaignId = Number(db.prepare("SELECT last_insert_rowid() AS id").get().id);
  let customerId = 100;
  for (const status of memberStatuses) {
    const emailId = insertEmail(db, customerId);
    db.prepare(
      `INSERT INTO outreach_campaign_members (campaign_id, customer_id, outreach_email_id, status)
       VALUES (?, ?, ?, ?)`,
    ).run(campaignId, customerId, emailId, status);
    customerId++;
  }
  return campaignId;
}

/** Transport that records which email ids actually reached "Gmail". */
function countingTransport(log: number[]) {
  return (async (_env: unknown, email: { id: number }) => {
    log.push(email.id);
    return { ok: true, gmail_message_id: `gm-${email.id}` };
  }) as unknown as typeof import("../src/gmail").sendOutreachEmail;
}

/** The production send path (Stage 10 machine) with a counting transport. */
function machineSend(log: number[]) {
  return ((env: GmailEnv, email: { id: number; email_to: string; subject: string | null; body: string | null }, options?: unknown) =>
    sendWithStateMachine(env, email, options as never, { transport: countingTransport(log) })) as never;
}

const quota = async () => ({ sent_today: 0, daily_limit: 400, remaining: 400 });
const count = (db: any, sql: string, ...args: unknown[]) => Number((db.prepare(sql).get(...args) as { n: number }).n);

/* ── §13.1: the lock primitive itself ────────────────────────────────────── */

describe("stage 12: campaign lock primitives (spec §13.1)", () => {
  it("acquire → held (second acquire refused) → release → re-acquirable", async () => {
    const db = withLocks(makeDb());
    const env = makeEnv(db);
    const first = await acquireCampaignLock(env, 7);
    expect(first).not.toBeNull();
    expect(count(db, "SELECT COUNT(*) AS n FROM campaign_locks WHERE campaign_id = 7")).toBe(1);
    expect(await acquireCampaignLock(env, 7)).toBeNull();
    await first!.release();
    expect(count(db, "SELECT COUNT(*) AS n FROM campaign_locks")).toBe(0);
    const second = await acquireCampaignLock(env, 7);
    expect(second).not.toBeNull();
    await second!.release();
  });

  it("expired lock is stolen atomically; the stale holder cannot release the new one", async () => {
    const db = withLocks(makeDb());
    const env = makeEnv(db);
    const stale = await acquireCampaignLock(env, 7);
    expect(stale).not.toBeNull();
    // Simulate the TTL expiring on the stale holder's row.
    db.prepare("UPDATE campaign_locks SET expires_at = ? WHERE campaign_id = 7")
      .run(sqlUtc(new Date(Date.now() - 60_000)));
    const fresh = await acquireCampaignLock(env, 7);
    expect(fresh).not.toBeNull(); // stolen through the ON CONFLICT guard
    await stale!.release(); // stale token — must NOT delete the fresh row
    expect(count(db, "SELECT COUNT(*) AS n FROM campaign_locks WHERE campaign_id = 7")).toBe(1);
    expect(await acquireCampaignLock(env, 7)).toBeNull(); // fresh holder still owns it
    await fresh!.release();
    expect(count(db, "SELECT COUNT(*) AS n FROM campaign_locks")).toBe(0);
  });

  it("CAMPAIGN_LOCK_TTL_MS overrides the expiry horizon (floor 60s applies)", async () => {
    const db = withLocks(makeDb());
    const env = makeEnv(db, { CAMPAIGN_LOCK_TTL_MS: String(60_000) });
    const lock = await acquireCampaignLock(env, 7);
    const row = db.prepare("SELECT locked_at, expires_at FROM campaign_locks WHERE campaign_id = 7").get() as { locked_at: string; expires_at: string };
    const from = Date.parse(`${row.locked_at.replace(" ", "T")}Z`);
    const to = Date.parse(`${row.expires_at.replace(" ", "T")}Z`);
    expect(to - from).toBe(60_000);
    await lock!.release();
  });

  it("missing campaign_locks table fails open (migration-pending window)", async () => {
    const db = makeDb(); // no campaign_locks table
    const env = makeEnv(db);
    const lock = await acquireCampaignLock(env, 7);
    expect(lock).not.toBeNull(); // proceeds unlocked — per-email claims carry the guarantee
    await lock!.release(); // no-op, must not throw
  });
});

/* ── §13.2: 10 workers, 100 members, at-most-once ────────────────────────── */

describe("stage 12: single-flight campaign execution (spec §13.2)", () => {
  it("10 concurrent send workers: exactly 1 runs, 9 get CampaignLockedError, lock released after", async () => {
    const db = withLocks(makeDb());
    const campaignId = seedCampaign(db, Array.from({ length: 100 }, () => "generated"));
    const calls: number[] = [];
    const env = makeEnv(db, { GMAIL_SEND_DELAY_MS: "0" });
    const settled = await Promise.allSettled(
      Array.from({ length: 10 }, () => runCampaignSend(env, campaignId, 50, { quota, send: machineSend(calls) })),
    );
    const ok = settled.filter((s): s is PromiseFulfilledResult<Awaited<ReturnType<typeof runCampaignSend>>> => s.status === "fulfilled");
    const busy = settled.filter((s) => s.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(busy).toHaveLength(9);
    for (const r of busy) expect(r.reason).toBeInstanceOf(CampaignLockedError);
    // The winner sent one capped batch of 50 — no duplicated work.
    expect(ok[0].value.generated).toBe(50);
    expect(calls).toHaveLength(50);
    expect(new Set(calls).size).toBe(50);
    // Lock is gone (finally released), nothing misreported as failed.
    expect(count(db, "SELECT COUNT(*) AS n FROM campaign_locks")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM outreach_campaign_members WHERE status = 'failed'")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM outreach_campaign_members WHERE status = 'sent'")).toBe(50);
    // Draining the rest sequentially still ends with every email sent once.
    for (let i = 0; i < 5; i++) {
      if ((await runCampaignSend(env, campaignId, 50, { quota, send: machineSend(calls) })).done) break;
    }
    expect(calls).toHaveLength(100);
    expect(new Set(calls).size).toBe(100);
    expect(count(db, "SELECT COUNT(*) AS n FROM outreach_emails WHERE status <> 'sent'")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM outreach_campaign_members WHERE status <> 'sent'")).toBe(0);
  });

  it("fail-open window (no locks table): 10 workers still send each email at most once", async () => {
    const db = makeDb(); // pre-migration database — lock unavailable
    const campaignId = seedCampaign(db, Array.from({ length: 100 }, () => "generated"));
    const calls: number[] = [];
    const env = makeEnv(db, { GMAIL_SEND_DELAY_MS: "0" });
    const settled = await Promise.allSettled(
      Array.from({ length: 10 }, () => runCampaignSend(env, campaignId, 50, { quota, send: machineSend(calls) })),
    );
    // Fail-open: every worker proceeds; Stage 10's per-email claims are the
    // hard guarantee. No email may reach the transport twice, and no member
    // may be misreported as failed by a worker that lost the per-email race.
    expect(settled.every((s) => s.status === "fulfilled")).toBe(true);
    expect(new Set(calls).size).toBe(calls.length);
    expect(count(db, "SELECT COUNT(*) AS n FROM outreach_campaign_members WHERE status = 'failed'")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM outreach_emails WHERE status = 'sent'")).toBe(new Set(calls).size);
    // Drain what the racing workers left behind.
    for (let i = 0; i < 10; i++) {
      if ((await runCampaignSend(env, campaignId, 50, { quota, send: machineSend(calls) })).done) break;
    }
    expect(calls).toHaveLength(100);
    expect(new Set(calls).size).toBe(100);
    expect(count(db, "SELECT COUNT(*) AS n FROM outreach_emails WHERE status <> 'sent'")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM outreach_campaign_members WHERE status <> 'sent'")).toBe(0);
  });

  it("the generate step takes the same lock — and a held lock blocks both steps", async () => {
    const db = withLocks(makeDb());
    const campaignId = seedCampaign(db, ["pending", "pending"]);
    const env = makeEnv(db);
    const generate = (async () => ({ drafts: [], already: [], errors: [] })) as never;
    const settled = await Promise.allSettled([
      runCampaignGenerate(env, campaignId, 10, { generate }),
      runCampaignGenerate(env, campaignId, 10, { generate }),
    ]);
    const ok = settled.filter((s) => s.status === "fulfilled");
    const busy = settled.filter((s) => s.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(busy).toHaveLength(1);
    expect(busy[0].reason).toBeInstanceOf(CampaignLockedError);
    expect(count(db, "SELECT COUNT(*) AS n FROM campaign_locks")).toBe(0);

    // Cross-step: a foreign holder blocks send AND generate until release.
    const held = await acquireCampaignLock(env, campaignId);
    expect(held).not.toBeNull();
    await expect(runCampaignSend(env, campaignId, 10, { quota })).rejects.toBeInstanceOf(CampaignLockedError);
    await expect(runCampaignGenerate(env, campaignId, 10, { generate })).rejects.toBeInstanceOf(CampaignLockedError);
    await held!.release();
    const after = await runCampaignSend(env, campaignId, 10, { quota });
    expect(after.processed).toBe(0); // proceeds again (nothing generated yet)
  });
});

/* ── Admin surface: busy is 409, not 500 ─────────────────────────────────── */

describe("stage 12: admin endpoints report a locked campaign as 409", () => {
  const call = (env: AdminEnv, path: string, init: RequestInit = {}) =>
    handleAdminRequest(new Request(`${BASE}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
    }), env) as Promise<Response>;

  it("POST /campaigns/:id/send and /generate return 409 while another worker holds the lock", async () => {
    const db = withAdminTables(withLocks(makeDb()));
    const campaignId = seedCampaign(db, ["generated", "generated"]);
    const now = new Date();
    db.prepare(
      `INSERT INTO campaign_locks (campaign_id, lock_token, locked_at, expires_at)
       VALUES (?, 'other-worker', ?, ?)`,
    ).run(campaignId, sqlUtc(now), sqlUtc(new Date(now.getTime() + 30 * 60 * 1000)));
    const env = makeEnv(db, { ADMIN_PANEL_TOKEN: TOKEN });

    const send = await call(env, `/admin/api/outreach/campaigns/${campaignId}/send`, {
      method: "POST", body: JSON.stringify({ limit: 5 }),
    });
    expect(send.status).toBe(409);
    expect((await send.json() as { detail: string }).detail).toContain("正在");

    const generate = await call(env, `/admin/api/outreach/campaigns/${campaignId}/generate`, {
      method: "POST", body: JSON.stringify({ limit: 5 }),
    });
    expect(generate.status).toBe(409);

    // The foreign lock is untouched — a refused request must never free
    // someone else's lock.
    const row = db.prepare("SELECT lock_token FROM campaign_locks WHERE campaign_id = ?").get(campaignId) as { lock_token: string };
    expect(row.lock_token).toBe("other-worker");
    // Reads stay available; only executions are single-flight.
    const detail = await call(env, `/admin/api/outreach/campaigns/${campaignId}`);
    expect(detail.status).toBe(200);
  });
});
