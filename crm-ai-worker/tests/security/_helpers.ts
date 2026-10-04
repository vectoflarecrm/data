import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { AdminEnv } from "../../src/admin";
import { handleAdminRequest } from "../../src/admin";

/* Security V2 Stage 22 (spec §23) — shared fixtures for the tests/security/
 * acceptance suite. These mirror the patterns of the stage-by-stage test
 * files (FakeD1 over node:sqlite + schema.sql) so the acceptance suite runs
 * against the real schema and the real request path (handleAdminRequest). */

export const SCHEMA_SQL = readFileSync(new URL("../../schema.sql", import.meta.url), "utf8");
export const TOKEN = "panel-token-for-tests";
export const BASE = "https://worker.example";

/** A valid 32-byte CREDENTIAL_ENC_KEY (base64), same trick as the stage-4
 * tests. Tests that exercise the fail-closed path omit it via makeEnv(db, {}). */
export const MASTER_KEY = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff)));

export function makeDb(): any {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA_SQL);
  return db;
}

/** Minimal D1 shim over node:sqlite. `explodeOn` makes any statement whose
 * SQL contains the substring reject — used to drive 500 / fail-open paths. */
export class FakeD1 {
  private explodeOn: string | null;
  constructor(public db: any, explodeOn: string | null = null) {
    this.explodeOn = explodeOn;
  }
  prepare(sql: string) {
    const db = this.db;
    const boom = this.explodeOn !== null && sql.includes(this.explodeOn);
    let bound: unknown[] = [];
    const stmt: any = {
      bind(...args: unknown[]) { bound = args; return stmt; },
      all: async () => {
        if (boom) throw new Error("D1 exploded");
        return { results: db.prepare(sql).all(...bound), success: true };
      },
      first: async () => {
        if (boom) throw new Error("D1 exploded");
        return db.prepare(sql).get(...bound) ?? undefined;
      },
      run: async () => {
        if (boom) throw new Error("D1 exploded");
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

export function makeEnv(
  db: any,
  opts: { key?: string | null; explodeOn?: string | null } = {},
): AdminEnv {
  const env: Record<string, unknown> = {
    DB: new FakeD1(db, opts.explodeOn ?? null),
    ADMIN_PANEL_TOKEN: TOKEN,
  };
  // Default ON (most flows need it); pass key: null to test fail-closed.
  if (opts.key !== null) env.CREDENTIAL_ENC_KEY = opts.key ?? MASTER_KEY;
  return env as unknown as AdminEnv;
}

/** Auth header sets — Bearer master token (super_admin) or a minted session
 * cookie for a specific role. */
export function bearer(token: string = TOKEN): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Insert a user with the given role and mint a live session cookie value. */
export async function mintSession(db: any, role: string): Promise<string> {
  const userId = `u_${role}`;
  db.prepare("INSERT OR IGNORE INTO admin_users (id, username, role) VALUES (?, ?, ?)")
    .run(userId, `user_${role}`, role);
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  db.prepare(
    `INSERT INTO admin_sessions (id, user_id, token_hash, role, created_at, expires_at)
     VALUES (?, ?, ?, ?, '2026-01-01 00:00:00', '2099-01-01 00:00:00')`,
  ).run(`s_${role}_${crypto.randomUUID()}`, userId, await sha256Hex(token), role);
  return token;
}

/** Full request through the public entry point (origin guard → auth → RBAC
 * gate → handler → security headers), like a real caller. */
export function call(
  env: AdminEnv,
  path: string,
  init: RequestInit & { headers?: Record<string, string> } = {},
): Promise<Response> {
  return handleAdminRequest(
    new Request(`${BASE}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    }),
    env,
  ) as Promise<Response>;
}
