import { describe, expect, it } from "vitest";
import type { GmailEnv, SendResult } from "../src/gmail";
import { sendWithStateMachine } from "../src/outreach-send";
import { FakeD1, makeDb } from "./security/_helpers";

/* Security V2 §32 — OUTREACH_DRY_RUN smoke-test guard.
 *
 * The flag must make a send walk the FULL state machine (claim → sending →
 * sent) while provably never reaching a real transport: no Gmail call, no
 * quota reservation, no 'sent' quota row. The guard resolves before the
 * injected transport on purpose — with the flag on, nothing can reach
 * Gmail, not even by accident. docs/deployment-v2.md builds the production
 * smoke procedure on exactly these guarantees.
 */

function makeEnv(db: any, overrides: Record<string, unknown> = {}): GmailEnv {
  return { DB: new FakeD1(db), ...overrides } as unknown as GmailEnv;
}

function seedDraft(db: any): void {
  db.prepare(
    "INSERT INTO customers (id, company_id, domain, status, company_name) VALUES (1, 'co-1', 'd1.test.example', 'completed', 'Smoke Customer')",
  ).run();
  db.prepare(
    "INSERT INTO outreach_emails (customer_id, company_id, email_to, subject, body, status) VALUES (1, 'co-1', 'smoke@test.example', 's', 'b', 'draft')",
  ).run();
}

/** A transport that must never be called — reaching it is the failure the
 * dry-run guard exists to prevent. */
function forbiddenTransport(): Promise<SendResult> {
  return Promise.reject(new Error("real transport reached — dry-run guard failed"));
}

describe("OUTREACH_DRY_RUN guard (spec §32)", () => {
  it("flag on: full state machine completes, transport never called, row visibly dry-run", async () => {
    const db = makeDb();
    seedDraft(db);
    const env = makeEnv(db, { OUTREACH_DRY_RUN: "true" });
    const result = await sendWithStateMachine(env, { id: 1, email_to: "smoke@test.example", subject: "s", body: "b" }, undefined, {
      transport: forbiddenTransport, // guard must resolve BEFORE this
    });
    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("sent");
    expect(result.gmail_message_id).toMatch(/^dry-run-/);
    const row = db.prepare("SELECT status, gmail_message_id, send_attempts FROM outreach_emails WHERE id = 1").get() as {
      status: string;
      gmail_message_id: string;
      send_attempts: number;
    };
    expect(row.status).toBe("sent");
    expect(row.gmail_message_id).toMatch(/^dry-run-/); // unmistakable in the panel
    expect(row.send_attempts).toBe(1); // the claim really ran
  });

  it("flag '1' engages the guard too", async () => {
    const db = makeDb();
    seedDraft(db);
    const env = makeEnv(db, { OUTREACH_DRY_RUN: "1" });
    const result = await sendWithStateMachine(env, { id: 1, email_to: "smoke@test.example", subject: "s", body: "b" }, undefined, {
      transport: forbiddenTransport,
    });
    expect(result.outcome).toBe("sent");
    expect(result.gmail_message_id).toMatch(/^dry-run-/);
  });

  it("dry run leaves no quota trail: no reservation, no 'sent' quota row", async () => {
    const db = makeDb();
    seedDraft(db);
    const env = makeEnv(db, { OUTREACH_DRY_RUN: "true" });
    await sendWithStateMachine(env, { id: 1, email_to: "smoke@test.example", subject: "s", body: "b" });
    const reservations = db.prepare("SELECT COUNT(*) AS c FROM gmail_send_reservations").get() as { c: number };
    const sends = db.prepare("SELECT COUNT(*) AS c FROM gmail_send_log").get() as { c: number };
    expect(reservations.c).toBe(0);
    expect(sends.c).toBe(0); // the real transport writes this — it never ran
  });

  it("dry run respects the state machine: the second attempt is already_sent", async () => {
    const db = makeDb();
    seedDraft(db);
    const env = makeEnv(db, { OUTREACH_DRY_RUN: "true" });
    const first = await sendWithStateMachine(env, { id: 1, email_to: "smoke@test.example", subject: "s", body: "b" });
    expect(first.outcome).toBe("sent");
    const second = await sendWithStateMachine(env, { id: 1, email_to: "smoke@test.example", subject: "s", body: "b" });
    expect(second.outcome).toBe("already_sent");
  });

  it("flag off or unrecognized: the normal (injected) transport runs", async () => {
    for (const flagValue of [undefined, "false", "yes", "0"]) {
      const db = makeDb();
      seedDraft(db);
      let called = 0;
      const env = makeEnv(db, flagValue === undefined ? {} : { OUTREACH_DRY_RUN: flagValue });
      const result = await sendWithStateMachine(
        env,
        { id: 1, email_to: "smoke@test.example", subject: "s", body: "b" },
        undefined,
        {
          transport: async () => {
            called++;
            return { ok: true, gmail_message_id: "real-abc123" };
          },
        },
      );
      expect(called).toBe(1); // the flag must NOT silently replace real sends
      expect(result.outcome).toBe("sent");
      expect(result.gmail_message_id).toBe("real-abc123");
    }
  });
});
