import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { AdminEnv } from "../src/admin";
import { handleAdminRequest } from "../src/admin";
import type { SendResult, GmailEnv } from "../src/gmail";
import { GmailTransportError } from "../src/gmail";
import { sendWithStateMachine, reapStaleSends } from "../src/outreach-send";
import { runCampaignSend } from "../src/campaigns";

/* Security V2 Stage 10 — Gmail sending state machine (spec §11).
 *
 * §11.4 test list, mapped:
 *   normal send ✓  Gmail success ✓  Gmail failure ✓  Gmail timeout ✓
 *   Worker timeout ✓  duplicate request ✓  duplicate campaign execution ✓
 *   retry ✓  uncertain send ✓  already sent ✓
 * Most important (§11.4): Gmail accepted the mail but the worker died before
 * writing the DB — the next attempt must NEVER send again. That is the
 * 'sending' + stale-lock case below: it becomes 'uncertain', which refuses
 * automatic resend.
 */

const TOKEN = "send-state-master-token";
const BASE = "https://worker.example";
/** Fixed clock so "stale" is a property of the fixture, not of wall time. */
const FIXED_NOW = new Date("2026-10-03T12:00:00Z");

function sqlUtc(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
  );
}
const STALE_LOCK = sqlUtc(new Date(FIXED_NOW.getTime() - 11 * 60 * 1000));
const FRESH_LOCK = sqlUtc(new Date(FIXED_NOW.getTime() - 30 * 1000));

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

/** Full state-machine schema: the columns migration 0009 adds, plus the
 * unique partial index so duplicate logical messages are refused for real. */
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
      /* Phase 9 (design §5): production members have carried contact_id
       * since the Phase 8 migration; the send path keys member rows by the
       * full (campaign, customer, contact) grain. NULL = company grain. */
      contact_id INTEGER,
      outreach_email_id INTEGER, status TEXT NOT NULL DEFAULT 'pending',
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
      enabled INTEGER DEFAULT 0, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    -- runCampaignSend's sendable-members query LEFT JOINs customers.
    CREATE TABLE customers (id INTEGER PRIMARY KEY, company_id TEXT, status TEXT, country TEXT);
  `);
  return db;
}

function makeEnv(db: any, overrides: Record<string, unknown> = {}): GmailEnv {
  return { DB: new FakeD1(db), ...overrides } as unknown as GmailEnv;
}

interface EmailRow {
  id?: number;
  customer_id?: number | null;
  email_to?: string;
  subject?: string;
  body?: string;
  status?: string;
  locked_at?: string | null;
  idempotency_key?: string | null;
}

function insertEmail(db: any, row: EmailRow = {}): number {
  const info = db.prepare(
    `INSERT INTO outreach_emails (customer_id, email_to, subject, body, status, locked_at, idempotency_key)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.customer_id ?? 5,
    row.email_to ?? "buyer@acme.com",
    row.subject ?? "Offer",
    row.body ?? "Hello, we supply parts.",
    row.status ?? "draft",
    row.locked_at ?? null,
    row.idempotency_key ?? null,
  );
  return Number(info.lastInsertRowid);
}

function emailRow(db: any, id: number): any {
  return db.prepare(
    `SELECT id, status, send_attempts, locked_at, locked_by, last_error,
            sent_at, gmail_message_id, idempotency_key
     FROM outreach_emails WHERE id = ?`,
  ).get(id);
}

/** Transport fake that counts calls and returns a canned result. */
function fakeTransport(result: SendResult | Error, log: string[] = []): typeof import("../src/gmail").sendOutreachEmail {
  return (async () => {
    log.push("called");
    if (result instanceof Error) throw result;
    return result;
  }) as any;
}

const fixedNow = () => new Date(FIXED_NOW);

/* ── §11.1 happy path and failure branches ──────────────────────────────── */

describe("stage 10: sending state machine (spec §11)", () => {
  it("normal send / Gmail success: draft → reserved → sending → sent with full trail", async () => {
    const db = makeDb();
    const id = insertEmail(db);
    const calls: string[] = [];
    const res = await sendWithStateMachine(
      makeEnv(db), { id, email_to: "buyer@acme.com", subject: "Offer", body: "Hello" },
      undefined, { transport: fakeTransport({ ok: true, gmail_message_id: "gm-123" }, calls), now: fixedNow },
    );
    expect(res).toMatchObject({ ok: true, outcome: "sent", gmail_message_id: "gm-123" });
    expect(calls).toHaveLength(1);
    const row = emailRow(db, id);
    expect(row.status).toBe("sent");
    expect(row.sent_at).toBeTruthy();
    expect(row.gmail_message_id).toBe("gm-123");
    expect(row.send_attempts).toBe(1);
    expect(row.locked_at).toBeNull();
    expect(row.locked_by).toBeNull();
    expect(row.last_error).toBeNull();
    expect(row.idempotency_key).toMatch(/^im-[0-9a-f]{24}$/);
  });

  it("Gmail failure (definite rejection): sending → failed with the reason", async () => {
    const db = makeDb();
    const id = insertEmail(db);
    const res = await sendWithStateMachine(
      makeEnv(db), { id, email_to: "buyer@acme.com", subject: "Offer", body: "Hello" },
      undefined, { transport: fakeTransport({ ok: false, error: "HTTP 550 mailbox unavailable" }), now: fixedNow },
    );
    expect(res.outcome).toBe("failed");
    expect(res.ok).toBe(false);
    const row = emailRow(db, id);
    expect(row.status).toBe("failed");
    expect(row.last_error).toContain("550");
    expect(row.locked_at).toBeNull();
  });

  it("Gmail timeout (network unknown): sending → uncertain, never silently draft", async () => {
    const db = makeDb();
    const id = insertEmail(db);
    const res = await sendWithStateMachine(
      makeEnv(db), { id, email_to: "buyer@acme.com", subject: "Offer", body: "Hello" },
      undefined,
      { transport: fakeTransport(new GmailTransportError("Gmail API 请求失败（送达状态未知）：timeout")), now: fixedNow },
    );
    expect(res.outcome).toBe("uncertain");
    const row = emailRow(db, id);
    expect(row.status).toBe("uncertain");
    expect(row.last_error).toContain("未知");
  });

  it("Worker timeout mid-send (unclassified error) → uncertain", async () => {
    const db = makeDb();
    const id = insertEmail(db);
    const res = await sendWithStateMachine(
      makeEnv(db), { id, email_to: "buyer@acme.com", subject: "Offer", body: "Hello" },
      undefined, { transport: fakeTransport(new Error("worker exceeded CPU limit")), now: fixedNow },
    );
    expect(res.outcome).toBe("uncertain");
    expect(emailRow(db, id).status).toBe("uncertain");
  });

  it("quota abort returns the row to draft and rethrows for batch stop detection", async () => {
    const db = makeDb();
    const id = insertEmail(db);
    await expect(sendWithStateMachine(
      makeEnv(db), { id, email_to: "buyer@acme.com", subject: "Offer", body: "Hello" },
      undefined, { transport: fakeTransport(new Error("今日 Gmail 发送配额已用完（400 封/天）")), now: fixedNow },
    )).rejects.toThrow(/配额/);
    const row = emailRow(db, id);
    expect(row.status).toBe("draft"); // retriable tomorrow
    expect(row.last_error).toContain("配额");
    expect(row.locked_at).toBeNull();
  });
});

/* ── §11.4 duplicate / retry / already-sent / uncertain ─────────────────── */

describe("stage 10: idempotent behavior (spec §11.4)", () => {
  const draft = (id: number) => ({ id, email_to: "buyer@acme.com", subject: "Offer", body: "Hello" });

  it("duplicate request after success → already_sent, transport called once", async () => {
    const db = makeDb();
    const id = insertEmail(db);
    const calls: string[] = [];
    const deps = { transport: fakeTransport({ ok: true, gmail_message_id: "gm-1" }, calls), now: fixedNow };
    const env = makeEnv(db);
    const first = await sendWithStateMachine(env, draft(id), undefined, deps);
    const second = await sendWithStateMachine(env, draft(id), undefined, deps);
    expect(first.outcome).toBe("sent");
    expect(second.outcome).toBe("already_sent");
    expect(second.ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("already-sent row is never handed to the transport again", async () => {
    const db = makeDb();
    const id = insertEmail(db, { status: "sent" });
    const calls: string[] = [];
    const res = await sendWithStateMachine(
      makeEnv(db), draft(id), undefined, { transport: fakeTransport({ ok: true }, calls), now: fixedNow },
    );
    expect(res.outcome).toBe("already_sent");
    expect(calls).toHaveLength(0);
  });

  it("retry: a failed row can be claimed again and succeeds (attempts = 2, key stable)", async () => {
    const db = makeDb();
    const id = insertEmail(db);
    const env = makeEnv(db);
    await sendWithStateMachine(env, draft(id), undefined,
      { transport: fakeTransport({ ok: false, error: "HTTP 550" }), now: fixedNow });
    const keyAfterFailure = emailRow(db, id).idempotency_key;
    const res = await sendWithStateMachine(env, draft(id), undefined,
      { transport: fakeTransport({ ok: true, gmail_message_id: "gm-2" }), now: fixedNow });
    expect(res.outcome).toBe("sent");
    const row = emailRow(db, id);
    expect(row.status).toBe("sent");
    expect(row.send_attempts).toBe(2);
    expect(row.idempotency_key).toBe(keyAfterFailure); // same logical message
  });

  it("uncertain send: blocked from automatic resend (the §11.4 critical rule)", async () => {
    const db = makeDb();
    const id = insertEmail(db, { status: "uncertain", last_error: "上次未知" });
    const calls: string[] = [];
    const res = await sendWithStateMachine(
      makeEnv(db), draft(id), undefined, { transport: fakeTransport({ ok: true }, calls), now: fixedNow },
    );
    expect(res.outcome).toBe("uncertain");
    expect(res.ok).toBe(false);
    expect(calls).toHaveLength(0);
    expect(emailRow(db, id).status).toBe("uncertain");
  });

  it("duplicate logical message (same campaign+customer+content in two rows) → claim refused", async () => {
    const db = makeDb();
    const a = insertEmail(db, { customer_id: 7, subject: "Same", body: "Same text" });
    const b = insertEmail(db, { customer_id: 7, subject: "Same", body: "Same text" });
    const calls: string[] = [];
    const deps = { transport: fakeTransport({ ok: true, gmail_message_id: "gm-x" }, calls), now: fixedNow };
    const env = makeEnv(db);
    const first = await sendWithStateMachine(env, draft(a), undefined, deps);
    const second = await sendWithStateMachine(env, draft(b), undefined, deps);
    expect(first.outcome).toBe("sent");
    expect(second.outcome).toBe("duplicate");
    expect(second.ok).toBe(false);
    expect(calls).toHaveLength(1);
    expect(emailRow(db, b).status).toBe("draft"); // untouched
  });
});

/* ── §11.4: crash between Gmail acceptance and the DB write ─────────────── */

describe("stage 10: crash recovery (spec §11.4 critical case)", () => {
  const draft = (id: number) => ({ id, email_to: "buyer@acme.com", subject: "Offer", body: "Hello" });

  it("row stuck in 'sending' with a FRESH lock → concurrent attempt skips, no resend", async () => {
    const db = makeDb();
    const id = insertEmail(db, { status: "sending", locked_at: FRESH_LOCK, locked_by: "worker-a" });
    const calls: string[] = [];
    const res = await sendWithStateMachine(
      makeEnv(db), draft(id), undefined, { transport: fakeTransport({ ok: true }, calls), now: fixedNow },
    );
    expect(res.outcome).toBe("skipped_locked");
    expect(calls).toHaveLength(0);
    expect(emailRow(db, id).status).toBe("sending"); // first worker still owns it
  });

  it("worker died after Gmail accepted, lock went stale → 'uncertain', next task NEVER resends", async () => {
    const db = makeDb();
    // The exact §11.4 scenario: Gmail said yes, the worker died before any
    // DB write — the row is still 'sending' with a lock older than the TTL.
    const id = insertEmail(db, { status: "sending", locked_at: STALE_LOCK, locked_by: "worker-dead" });
    const calls: string[] = [];
    const deps = { transport: fakeTransport({ ok: true }, calls), now: fixedNow };
    const env = makeEnv(db);
    const res = await sendWithStateMachine(env, draft(id), undefined, deps);
    expect(res.outcome).toBe("uncertain");
    expect(calls).toHaveLength(0); // ← the rule: no automatic re-send
    expect(emailRow(db, id).status).toBe("uncertain");
    // And it stays refused on the next attempt too.
    const again = await sendWithStateMachine(env, draft(id), undefined, deps);
    expect(again.outcome).toBe("uncertain");
    expect(calls).toHaveLength(0);
  });

  it("stale 'reserved' (died before the Gmail call) → back to draft and sendable", async () => {
    const db = makeDb();
    const id = insertEmail(db, { status: "reserved", locked_at: STALE_LOCK, locked_by: "worker-dead" });
    const calls: string[] = [];
    const res = await sendWithStateMachine(
      makeEnv(db), draft(id), undefined, { transport: fakeTransport({ ok: true, gmail_message_id: "gm-9" }, calls), now: fixedNow },
    );
    expect(res.outcome).toBe("sent");
    expect(calls).toHaveLength(1);
    expect(emailRow(db, id).status).toBe("sent");
  });

  it("reapStaleSends splits by phase: reserved → draft, sending → uncertain", async () => {
    const db = makeDb();
    const reservedId = insertEmail(db, { status: "reserved", locked_at: STALE_LOCK });
    const sendingId = insertEmail(db, { status: "sending", locked_at: STALE_LOCK });
    const liveId = insertEmail(db, { status: "sending", locked_at: FRESH_LOCK });
    await reapStaleSends(makeEnv(db), FIXED_NOW);
    expect(emailRow(db, reservedId).status).toBe("draft");
    expect(emailRow(db, sendingId).status).toBe("uncertain");
    expect(emailRow(db, liveId).status).toBe("sending"); // fresh lock untouched
  });

  it("concurrent claims: exactly one contender wins and sends", async () => {
    const db = makeDb();
    const id = insertEmail(db);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const hangingTransport = (async () => {
      calls++;
      await gate;
      return { ok: true, gmail_message_id: "gm-race" };
    }) as any;
    const deps = { transport: hangingTransport, now: fixedNow };
    const env = makeEnv(db);
    const first = sendWithStateMachine(env, { id, email_to: "b@a.com", subject: "S", body: "B" }, undefined, deps);
    // Wait until the first attempt has actually claimed the row.
    for (let i = 0; i < 100 && emailRow(db, id).status !== "sending"; i++) {
      await new Promise((r) => setTimeout(r, 1));
    }
    expect(emailRow(db, id).status).toBe("sending");
    const second = await sendWithStateMachine(env, { id, email_to: "b@a.com", subject: "S", body: "B" }, undefined, deps);
    expect(second.outcome).toBe("skipped_locked");
    release();
    expect((await first).outcome).toBe("sent");
    expect(calls).toBe(1);
    expect(emailRow(db, id).status).toBe("sent");
  });
});

/* ── §11.4: duplicate campaign execution ────────────────────────────────── */

describe("stage 10: campaign send through the state machine", () => {
  function seedCampaign(db: any, memberStatuses: string[]): number {
    db.prepare(
      `INSERT INTO outreach_campaigns (name, brand_name, group_id, filters, total, status)
       VALUES ('Q4 push', 'Afarer', 1, '{}', ?, 'sending')`,
    ).run(memberStatuses.length);
    const campaignId = Number(db.prepare("SELECT last_insert_rowid() AS id").get().id);
    let customerId = 100;
    for (const status of memberStatuses) {
      const emailId = insertEmail(db, { customer_id: customerId, status: "draft" });
      db.prepare(
        `INSERT INTO outreach_campaign_members (campaign_id, customer_id, outreach_email_id, status)
         VALUES (?, ?, ?, ?)`,
      ).run(campaignId, customerId, emailId, status);
      customerId++;
    }
    return campaignId;
  }

  const adminEnv = (db: any) =>
    ({ DB: new FakeD1(db), GMAIL_SEND_DELAY_MS: "0", ADMIN_PANEL_TOKEN: TOKEN } as unknown as AdminEnv);
  const quota = async () => ({ sent_today: 0, daily_limit: 400, remaining: 400 });

  it("duplicate campaign execution sends every email exactly once", async () => {
    const db = makeDb();
    const campaignId = seedCampaign(db, ["generated", "generated"]);
    const calls: string[] = [];
    const deps = {
      quota,
      send: ((env: GmailEnv, email: { id: number; email_to: string; subject: string | null; body: string | null }, options?: unknown) =>
        sendWithStateMachine(env, email, options as never, { transport: fakeTransport({ ok: true, gmail_message_id: "gm-c" }, calls), now: fixedNow })) as never,
    };
    const env = adminEnv(db);
    const first = await runCampaignSend(env, campaignId, 10, deps);
    expect(first.generated).toBe(2); // 'generated' counts sent emails in the send step
    const second = await runCampaignSend(env, campaignId, 10, deps);
    expect(second.processed).toBe(0);
    expect(second.generated).toBe(0);
    expect(calls).toHaveLength(2); // exactly once per email, across both runs
    const statuses = db.prepare("SELECT status FROM outreach_emails").all() as Array<{ status: string }>;
    expect(statuses.every((r) => r.status === "sent")).toBe(true);
  });

  it("quota stop leaves members 'generated' and emails 'draft' for tomorrow", async () => {
    const db = makeDb();
    const campaignId = seedCampaign(db, ["generated"]);
    const deps = {
      quota,
      send: ((env: GmailEnv, email: { id: number; email_to: string; subject: string | null; body: string | null }, options?: unknown) =>
        sendWithStateMachine(env, email, options as never, {
          transport: fakeTransport(new Error("今日 Gmail 发送配额已用完（400 封/天）")),
          now: fixedNow,
        })) as never,
    };
    const env = adminEnv(db);
    const stopped = await runCampaignSend(env, campaignId, 5, deps);
    expect(stopped.quotaStop).toBe(true);
    expect(db.prepare("SELECT status FROM outreach_campaign_members").get().status).toBe("generated");
    expect(db.prepare("SELECT status FROM outreach_emails").get().status).toBe("draft");
  });
});

/* ── Admin endpoints under the state machine ────────────────────────────── */

describe("stage 10: admin endpoints enforce the machine", () => {
  function adminEnv(db: any): AdminEnv {
    return { DB: new FakeD1(db), ADMIN_PANEL_TOKEN: TOKEN } as unknown as AdminEnv;
  }
  function fullDb(): any {
    const db = makeDb();
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
  const call = (env: AdminEnv, path: string, init: RequestInit = {}) =>
    handleAdminRequest(new Request(`${BASE}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
    }), env) as Promise<Response>;

  it("single send without Gmail config → ok:false and the row is honestly 'failed'", async () => {
    const db = fullDb();
    const id = insertEmail(db);
    const res = await call(adminEnv(db), `/admin/api/outreach/emails/${id}/send`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; outcome: string };
    expect(body.ok).toBe(false);
    expect(body.outcome).toBe("failed");
    const row = emailRow(db, id);
    expect(row.status).toBe("failed"); // previously it silently stayed 'draft'
    expect(row.last_error).toContain("发信账号");
  });

  it("single send refuses in-flight and uncertain rows with 409", async () => {
    const db = fullDb();
    const sending = insertEmail(db, { status: "sending", locked_at: FRESH_LOCK });
    const uncertain = insertEmail(db, { status: "uncertain" });
    const env = adminEnv(db);
    const inFlight = await call(env, `/admin/api/outreach/emails/${sending}/send`, { method: "POST" });
    expect(inFlight.status).toBe(409);
    const blocked = await call(env, `/admin/api/outreach/emails/${uncertain}/send`, { method: "POST" });
    expect(blocked.status).toBe(409);
    expect((await blocked.json() as { detail: string }).detail).toContain("未知");
    expect(emailRow(db, uncertain).status).toBe("uncertain");
  });

  it("send-batch retries failed rows but never touches reserved/sending/uncertain", async () => {
    const db = fullDb();
    const draftId = insertEmail(db, { customer_id: 1, email_to: "a@x.com" });
    const failedId = insertEmail(db, { customer_id: 2, email_to: "b@x.com", status: "failed" });
    insertEmail(db, { customer_id: 3, email_to: "c@x.com", status: "reserved", locked_at: FRESH_LOCK });
    insertEmail(db, { customer_id: 4, email_to: "d@x.com", status: "uncertain" });
    const res = await call(adminEnv(db), "/admin/api/outreach/send-batch", {
      method: "POST", body: JSON.stringify({ limit: 10 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { attempted: number; failed: number; results: Array<{ id: number }> };
    expect(body.attempted).toBe(2); // draft + failed only
    expect(new Set(body.results.map((r) => r.id))).toEqual(new Set([draftId, failedId]));
    // No Gmail config in the fixture → both attempts end 'failed', not limbo.
    expect(emailRow(db, draftId).status).toBe("failed");
    expect(emailRow(db, failedId).status).toBe("failed");
  });
});
