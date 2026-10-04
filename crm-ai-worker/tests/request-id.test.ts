import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import type { AdminEnv } from "../src/admin";
import { handleAdminRequest } from "../src/admin";
import { invalidateProviderCache } from "../src/provider-keys";

/* Security V2 Stage 20 — request id / traceability (spec §21).
 *
 * Every admin/API request gets one minted UUID that is returned as the
 * X-Request-ID response header, written into audit_logs.request_id for every
 * audit row produced while serving the request, and reused by 500 responses
 * so body, header and the safeLog'd error line all correlate. The chain
 * answers "这一封邮件为什么被发送？": the response header id ↔ the audit
 * CAMPAIGN_* rows ↔ the Worker log.
 */

const SCHEMA_SQL = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function makeDb(): any {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA_SQL);
  return db;
}

const TOKEN = "panel-token-for-tests";

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

/** Passes everything through, but makes D1 statements touching api_configs
 * explode — used to drive a handler into the 500 path. */
class ExplodingKeysD1 extends FakeD1 {
  prepare(sql: string) {
    if (sql.includes("FROM api_configs")) {
      return {
        bind: () => this.prepare(sql),
        all: async () => { throw new Error("D1 exploded"); },
        first: async () => { throw new Error("D1 exploded"); },
        run: async () => { throw new Error("D1 exploded"); },
      } as any;
    }
    return super.prepare(sql);
  }
}

function makeEnv(db: any): AdminEnv {
  invalidateProviderCache();
  return { DB: new FakeD1(db), ADMIN_PANEL_TOKEN: TOKEN } as unknown as AdminEnv;
}

function call(env: AdminEnv, path: string, init: RequestInit = {}) {
  return handleAdminRequest(
    new Request(`https://worker.example${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TOKEN}`,
        ...(init.headers ?? {}),
      },
    }),
    env,
  ) as Promise<Response>;
}

describe("X-Request-ID (spec §21)", () => {
  it("every admin API response carries a minted UUID", async () => {
    const db = makeDb();
    const res = await call(makeEnv(db), "/admin/api/customers");
    const id = res.headers.get("X-Request-ID");
    expect(id).toBeTruthy();
    expect(id).toMatch(UUID_RE);
  });

  it("panel HTML responses carry it too", async () => {
    const db = makeDb();
    const res = await handleAdminRequest(
      new Request("https://worker.example/admin"),
      { DB: new FakeD1(db), ADMIN_PANEL_TOKEN: TOKEN } as unknown as AdminEnv,
    ) as Response;
    expect(res.headers.get("X-Request-ID")).toMatch(UUID_RE);
  });

  it("each request gets a fresh id", async () => {
    const db = makeDb();
    const env = makeEnv(db);
    const id1 = (await call(env, "/admin/api/customers")).headers.get("X-Request-ID");
    const id2 = (await call(env, "/admin/api/customers")).headers.get("X-Request-ID");
    expect(id1).not.toBe(id2);
  });

  it("ignores a client-supplied X-Request-ID (the server always mints)", async () => {
    const db = makeDb();
    const res = await call(makeEnv(db), "/admin/api/customers", {
      headers: { "X-Request-ID": "00000000-0000-0000-0000-000000000000" },
    });
    const id = res.headers.get("X-Request-ID");
    expect(id).toMatch(UUID_RE);
    expect(id).not.toBe("00000000-0000-0000-0000-000000000000");
  });

  it("audit rows written while serving a request carry the same request_id", async () => {
    const db = makeDb();
    db.prepare(
      "INSERT INTO customers (company_id, domain, status) VALUES ('c1', 'acme.com', 'completed')",
    ).run();
    const env = makeEnv(db);
    const res = await call(env, "/admin/api/customers/1", {
      method: "PATCH",
      body: JSON.stringify({ status: "pending" }),
    });
    expect(res.status).toBe(200);
    const headerId = res.headers.get("X-Request-ID");
    const row = db.prepare(
      "SELECT action, request_id FROM audit_logs ORDER BY created_at DESC LIMIT 1",
    ).get() as { action: string; request_id: string };
    expect(row.action).toBe("UPDATE_CUSTOMER");
    expect(row.request_id).toBe(headerId);
  });

  it("a 500's body request_id matches the X-Request-ID header", async () => {
    const db = makeDb();
    const env = { DB: new ExplodingKeysD1(db), ADMIN_PANEL_TOKEN: TOKEN } as unknown as AdminEnv;
    invalidateProviderCache();
    const res = await call(env, "/admin/api/keys");
    expect(res.status).toBe(500);
    const body = await res.json() as { request_id: string };
    expect(body.request_id).toBe(res.headers.get("X-Request-ID"));
    expect(body.request_id).toMatch(UUID_RE);
  });
});
