import { describe, it, expect } from "vitest";
import { makeDb, makeEnv, call, bearer, BASE } from "./_helpers";
import { handleAdminRequest } from "../../src/admin";
import { MAX_CSV_BYTES, MAX_CSV_ROWS, MAX_COLUMNS, MAX_FIELD_BYTES } from "../../src/security/csv-limits";

/* Security V2 Stage 22 (spec §23) — CSV LIMIT acceptance.
 *
 * The import endpoint is the panel's resource-consumption entry point
 * (Stage 8). Every cap is asserted end-to-end through the API — byte cap
 * (streamed, no Content-Length to lean on), row cap, column cap, field
 * cap — plus the happy path so the caps are proven not to over-block. */

function importReq(csv: string | ReadableStream<Uint8Array>): Request {
  // undici requires duplex:"half" for stream bodies (not in lib DOM types).
  const init = typeof csv === "string"
    ? { method: "POST", headers: { Authorization: `Bearer panel-token-for-tests`, "Content-Type": "application/json" }, body: JSON.stringify({ csv, file_name: "t.csv" }) }
    : { method: "POST", headers: { Authorization: `Bearer panel-token-for-tests`, "Content-Type": "application/json" }, body: csv, duplex: "half" };
  return new Request(`${BASE}/admin/api/customers/import`, init as RequestInit);
}

function importCsv(env: ReturnType<typeof makeEnv>, csv: string | ReadableStream<Uint8Array>): Promise<Response> {
  return handleAdminRequest(importReq(csv), env) as Promise<Response>;
}

describe("CSV limit acceptance", () => {
  it("a normal small import succeeds", async () => {
    const env = makeEnv(makeDb());
    const res = await importCsv(env, "company_name\nAcme Co\n");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { inserted: number }).inserted).toBe(1);
  });

  it("an oversized csv value is refused 413", async () => {
    const env = makeEnv(makeDb());
    const res = await importCsv(env, "a".repeat(MAX_CSV_BYTES + 1));
    expect(res.status).toBe(413);
  });

  it("more than MAX_CSV_ROWS data rows is refused 400", async () => {
    const env = makeEnv(makeDb());
    const rows = Array.from({ length: MAX_CSV_ROWS + 1 }, (_, i) => `C${i}`).join("\n");
    const res = await importCsv(env, `company_name\n${rows}`);
    expect(res.status).toBe(400);
  });

  it("more than MAX_COLUMNS columns is refused 400", async () => {
    const env = makeEnv(makeDb());
    const header = Array.from({ length: MAX_COLUMNS + 1 }, (_, i) => `c${i}`).join(",");
    const res = await importCsv(env, `${header}\n${Array.from({ length: MAX_COLUMNS + 1 }, () => "x").join(",")}`);
    expect(res.status).toBe(400);
  });

  it("a single field over MAX_FIELD_BYTES is refused 400", async () => {
    const env = makeEnv(makeDb());
    const res = await importCsv(env, `company_name\n${"x".repeat(MAX_FIELD_BYTES + 1)}`);
    expect(res.status).toBe(400);
  });

  it("a chunked upload with no Content-Length is still capped by the stream guard", async () => {
    const env = makeEnv(makeDb());
    const chunk = new TextEncoder().encode(`{"csv":"${"a".repeat(1000)}"}`).slice(0, 1024);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // MAX_CSV_BYTES + slack, delivered in small chunks so only the
        // cumulative stream counter can catch it.
        const total = MAX_CSV_BYTES + 512 * 1024;
        for (let sent = 0; sent < total; sent += chunk.byteLength) {
          controller.enqueue(chunk);
        }
        controller.close();
      },
    });
    const res = await importCsv(env, stream);
    expect(res.status).toBe(413);
  });

  it("a non-string csv value is refused 400, and nothing is imported", async () => {
    const db = makeDb();
    const env = makeEnv(db);
    const res = await call(env, "/admin/api/customers/import", {
      method: "POST",
      body: JSON.stringify({ csv: 42 }),
      headers: bearer(),
    });
    expect(res.status).toBe(400);
    expect((db.prepare("SELECT COUNT(*) AS n FROM customers").get() as { n: number }).n).toBe(0);
  });

  it("the import requires customers.write — readonly is 403", async () => {
    const db = makeDb();
    const env = makeEnv(db);
    const { mintSession } = await import("./_helpers");
    const token = await mintSession(db, "readonly");
    const res = await call(env, "/admin/api/customers/import", {
      method: "POST",
      body: JSON.stringify({ csv: "company_name\nAcme\n" }),
      headers: { Cookie: `crm_session=${token}` },
    });
    expect(res.status).toBe(403);
    expect((db.prepare("SELECT COUNT(*) AS n FROM customers").get() as { n: number }).n).toBe(0);
  });
});
