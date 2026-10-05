import { describe, expect, it } from "vitest";
import { callGeminiOutreach } from "../src/outreach";
import { makeDb, makeEnv } from "./security/_helpers";

/* Post-V2 hygiene — the outreach Gemini call site used to carry the API key
 * in the URL query (`?key=…`), unlike the analysis call site which already
 * used the x-goog-api-key header. Any error path that embeds the request
 * URL (fetch rejections, provider diagnostics, future log lines) would
 * ship the key into logs — safeLog scrubs Bearer/PEM/enc:v1 shapes, not
 * query strings. Now both sites share the same transport contract.
 */

interface RecordedCall {
  url: string;
  headers: Record<string, string>;
  body: string;
}

function geminiResponse(): Response {
  return new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify({ subject: "s", body: "b" }) }] } }],
    }),
    { status: 200 },
  );
}

describe("callGeminiOutreach transport contract", () => {
  it("sends the key in the x-goog-api-key header, never in the URL", async () => {
    const calls: RecordedCall[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: String(init?.body ?? ""),
      });
      return geminiResponse();
    }) as typeof fetch;
    try {
      const result = await callGeminiOutreach(makeEnv(makeDb()), "prompt-text", "test-key-value");
      expect(result).toEqual({ subject: "s", body: "b" });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(calls).toHaveLength(1);
    expect(calls[0].url).not.toContain("key=");
    expect(calls[0].url).not.toContain("test-key-value");
    expect(calls[0].headers["x-goog-api-key"]).toBe("test-key-value");
  });

  it("URL-encodes the model name (parity with the analysis call site)", async () => {
    const calls: RecordedCall[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string>, body: "" });
      return geminiResponse();
    }) as typeof fetch;
    try {
      const env: Record<string, unknown> = makeEnv(makeDb());
      env.GEMINI_MODEL = "models/gemini-x:latest"; // would break an unencoded path segment
      await callGeminiOutreach(env as never, "prompt", "k");
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(calls[0].url).toContain(encodeURIComponent("models/gemini-x:latest"));
  });
});
