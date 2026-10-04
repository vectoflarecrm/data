import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import type { AdminEnv } from "../src/admin";
import { handleAdminRequest } from "../src/admin";
import { invalidateProviderCache } from "../src/provider-keys";

/* Security V2 Stage 17 — database integrity (spec §18).
 *
 * §18.1 mapping (each "防止" item and where it is enforced):
 *   orphan campaign member → PK(campaign_id, customer_id) +
 *     deleteCampaign's member-before-campaign cascade; no code path
 *     deletes customers, so a member can never lose its customer
 *   orphan outreach email → real FK outreach_emails(customer_id) →
 *     customers(id), asserted below (D1 enforces FKs by default)
 *   duplicate email → gmail_accounts.client_email UNIQUE, asserted below
 *     (+ Stage 10's idempotency partial index on outreach_emails covers
 *     the send side)
 *   duplicate customer domain → idx_customers_domain, asserted below;
 *     PATCH conflicts surface as 409
 *   duplicate API fingerprint → idx_api_configs_fingerprint (per-provider,
 *     matching bulk-import semantics) + the single-key POST 409 pre-check,
 *     both asserted below
 *   duplicate Gmail account → gmail_accounts.client_email UNIQUE, below
 *
 * FK/NOT NULL/CHECK cannot be added to pre-existing SQLite tables without
 * a rebuild; the audit matrix and rationale live in
 * docs/stages/stage-17-database-integrity.md.
 */

const SCHEMA_SQL = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");

// The §18.1 unique indexes, verbatim from the CI step (deploy-worker.yml
// "Migrate contacts + integrity indexes"). A production-shaped fixture is
// schema.sql + these — exactly what a fresh install plus one CI run yields.
const CI_UNIQUE_INDEXES = [
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_domain ON customers(domain) WHERE domain != ''",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_api_configs_fingerprint ON api_configs(provider, key_fingerprint) WHERE key_fingerprint IS NOT NULL",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_contact_id ON contacts(contact_id)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_seq ON contacts(company_id, seq)",
];

/** D1 behaves as if PRAGMA foreign_keys = ON for every connection. */
function makeDb(): any {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  for (const stmt of CI_UNIQUE_INDEXES) db.exec(stmt);
  return db;
}

describe("schema.sql integrity (fresh install = post-CI production shape)", () => {
  it("creates the full §18 table set and is re-runnable (CI executes it every deploy)", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(SCHEMA_SQL);
    db.exec(SCHEMA_SQL); // idempotency: IF NOT EXISTS everywhere
    for (const stmt of CI_UNIQUE_INDEXES) db.exec(stmt);
    for (const stmt of CI_UNIQUE_INDEXES) db.exec(stmt); // CI re-runs are idempotent too
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name);
    for (const t of [
      "customers", "contacts", "evidence", "outreach_campaigns",
      "outreach_campaign_members", "outreach_emails", "gmail_accounts",
      "api_configs", "audit_logs", "research_runs",
    ]) {
      expect(tables).toContain(t);
    }
    const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>).map((r) => r.name);
    for (const i of ["idx_contacts_company", "idx_research_runs_customer", ...CI_UNIQUE_INDEXES.map((s) => /idx_\w+/.exec(s)![0])]) {
      expect(indexes).toContain(i);
    }
  });

  it("customers covers the panel read surface (display_id + CI-ALTER columns included)", () => {
    // Regression guard for the fresh-install gap: display_id and the four
    // workflow-ALTER columns used to be missing from the CREATE, so any
    // customer query on a fresh database failed.
    const db = makeDb();
    db.prepare("INSERT INTO customers (company_id, display_id, domain, lead_score, data_completeness_score) VALUES ('c1', 'D-001', 'acme.com', 80, 70)").run();
    const row = db.prepare(
      "SELECT id, company_id, display_id, domain, lead_score, buying_signals, source_import_id, data_completeness_score FROM customers WHERE company_id = 'c1'",
    ).get() as Record<string, unknown>;
    expect(row.display_id).toBe("D-001");
    expect(row.lead_score).toBe(80);
    expect(row.data_completeness_score).toBe(70);
  });

  it("contacts supports the research save path (INSERT OR IGNORE) on a fresh database", () => {
    // Before Stage 17 this table did not exist outside production — the
    // research save step failed with "no such table: contacts".
    const db = makeDb();
    const ins = "INSERT OR IGNORE INTO contacts (contact_id, company_id, seq, first_name, last_name, title, email, cellphone, whatsapp, linkedin_url, department) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
    const info = db.prepare(ins).run("c1_001", "c1", 1, "Alice", "Smith", "CEO", "a@acme.com", null, null, null, null);
    expect(info.changes).toBe(1);
    const ignored = db.prepare(ins).run("c1_001", "c1", 1, "Alice", "Smith", "CEO", "a@acme.com", null, null, null, null);
    expect(ignored.changes).toBe(0); // duplicate contact_id → IGNORE, no error
  });
});

describe("§18.1 — duplicate prevention at the DB level", () => {
  it("customers: non-empty domains are unique; empty import placeholders coexist", () => {
    const db = makeDb();
    db.prepare("INSERT INTO customers (company_id, domain) VALUES ('c1', 'acme.com')").run();
    expect(() => db.prepare("INSERT INTO customers (company_id, domain) VALUES ('c2', 'acme.com')").run()).toThrow();
    // Import rows without a usable domain carry '' — the partial index must not bind them.
    db.prepare("INSERT INTO customers (company_id, domain) VALUES ('c3', '')").run();
    db.prepare("INSERT INTO customers (company_id, domain) VALUES ('c4', '')").run();
  });

  it("api_configs: (provider, key_fingerprint) unique per provider; NULL fingerprints and cross-provider duplicates allowed", () => {
    const db = makeDb();
    const ins = "INSERT INTO api_configs (provider, api_key, key_fingerprint) VALUES (?, ?, ?)";
    db.prepare(ins).run("groq", "enc:v1:a", "fp1");
    expect(() => db.prepare(ins).run("groq", "enc:v1:b", "fp1")).toThrow();
    // Same fingerprint under another provider is documented bulk-import
    // semantics (dedup is per-provider), so the index must allow it.
    db.prepare(ins).run("gemini", "enc:v1:c", "fp1");
    // Pre-Stage-4 rows have no fingerprint — excluded by the partial index.
    db.prepare("INSERT INTO api_configs (provider, api_key) VALUES ('groq', 'legacy-1')").run();
    db.prepare("INSERT INTO api_configs (provider, api_key) VALUES ('deepseek', 'legacy-2')").run();
  });

  it("gmail_accounts: client_email is unique (duplicate Gmail account rejected)", () => {
    const db = makeDb();
    const ins = "INSERT INTO gmail_accounts (client_email, private_key) VALUES (?, ?)";
    db.prepare(ins).run("sa@project.iam.gserviceaccount.com", "-----PEM-----");
    expect(() => db.prepare(ins).run("sa@project.iam.gserviceaccount.com", "-----PEM-2-----")).toThrow();
  });

  it("contacts: (company_id, seq) is unique — a plain insert cannot shadow an existing slot", () => {
    const db = makeDb();
    db.prepare("INSERT INTO contacts (contact_id, company_id, seq) VALUES ('c1_001', 'c1', 1)").run();
    expect(() => db.prepare("INSERT INTO contacts (contact_id, company_id, seq) VALUES ('c1_002', 'c1', 1)").run()).toThrow();
    // Same seq under a different company is a different slot.
    db.prepare("INSERT INTO contacts (contact_id, company_id, seq) VALUES ('c2_001', 'c2', 1)").run();
  });
});

describe("§18.1 — orphan prevention at the DB level", () => {
  it("outreach_emails carries a real FK to customers (orphan email impossible)", () => {
    // D1 enforces FKs by default; makeDb mirrors that with the pragma.
    const db = makeDb();
    expect(() => db.prepare("INSERT INTO outreach_emails (customer_id, email_to) VALUES (999, 'a@b.com')").run()).toThrow();
    db.prepare("INSERT INTO customers (company_id, domain) VALUES ('c1', 'acme.com')").run();
    const id = (db.prepare("SELECT id FROM customers WHERE company_id = 'c1'").get() as { id: number }).id;
    db.prepare("INSERT INTO outreach_emails (customer_id, email_to) VALUES (?, 'a@b.com')").run(id);
  });
});

/* ── Admin API behaviour on top of the integrity layer ────────────────── */

const TOKEN = "panel-token-for-tests";
const MASTER = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i)));

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

function makeEnv(db: any): AdminEnv {
  invalidateProviderCache();
  return { DB: new FakeD1(db), ADMIN_PANEL_TOKEN: TOKEN, CREDENTIAL_ENC_KEY: MASTER } as unknown as AdminEnv;
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

describe("single-key POST fingerprint dedup (§18.1 duplicate API fingerprint)", () => {
  it("409s the same key for the same provider; a different provider still accepts it", async () => {
    const db = makeDb();
    const env = makeEnv(db);
    const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });

    const first = await call(env, "/admin/api/keys", post({ provider: "groq", api_key: "gsk_live_abcdef123456" }));
    expect(first.status).toBe(200);

    const dupe = await call(env, "/admin/api/keys", post({ provider: "groq", api_key: "gsk_live_abcdef123456" }));
    expect(dupe.status).toBe(409);
    expect(await dupe.json()).toMatchObject({ detail: expect.stringContaining("指纹重复") });

    // Cross-provider duplicates are documented-allowed (bulk semantics).
    const other = await call(env, "/admin/api/keys", post({ provider: "gemini", api_key: "gsk_live_abcdef123456" }));
    expect(other.status).toBe(200);

    const rows = db.prepare("SELECT provider FROM api_configs ORDER BY provider").all() as Array<{ provider: string }>;
    expect(rows.map((r) => r.provider)).toEqual(["gemini", "groq"]);
  });
});

describe("PATCH customer domain conflict maps to 409 (§18.1 duplicate customer domain)", () => {
  it("rejects a duplicate domain with a clear message and still accepts unique ones", async () => {
    const db = makeDb();
    // validateDomain() stores PATCHed domains in URL form ("https://acme.com/"),
    // so a stored conflict looks like this. The unique index enforces
    // exact-string uniqueness; semantic normalization is normalized_domain's
    // job and stays out of scope here.
    db.prepare("INSERT INTO customers (company_id, display_id, domain, status, company_name) VALUES ('c1', 'D-001', 'https://acme.com/', 'completed', 'Acme')").run();
    db.prepare("INSERT INTO customers (company_id, display_id, domain, status, company_name) VALUES ('c2', 'D-002', 'https://beta.com/', 'completed', 'Beta')").run();
    const env = makeEnv(db);
    const patch = (id: number, body: unknown) => ({ method: "PATCH", body: JSON.stringify(body) });

    const conflict = await call(env, "/admin/api/customers/2", patch(2, { domain: "acme.com" }));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ detail: "该 domain 已被其他客户占用" });

    const ok = await call(env, "/admin/api/customers/2", patch(2, { domain: "beta.org" }));
    expect(ok.status).toBe(200);
    const body = await ok.json() as { domain: string };
    expect(body.domain).toBe("https://beta.org/");
  });
});
