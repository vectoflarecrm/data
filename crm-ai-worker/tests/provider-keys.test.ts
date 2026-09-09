import { describe, it, expect, beforeEach } from "vitest";
import {
  getProviderState,
  isProviderUsable,
  invalidateProviderCache,
  keyHealthName,
  noteProviderKeyError,
  noteProviderKeySuccess,
  type ProviderKeyEntry,
} from "../src/provider-keys";

// Minimal in-memory D1 stub covering the queries provider-keys.ts issues.
// Tables: api_configs(provider, label, api_key, rpm_limit, is_active, model,
// last_error, last_used_at, id), provider_settings(provider, default_model,
// rpm_total, enabled).
function makeDb(tables: {
  apiConfigs?: Array<Record<string, unknown>>;
  settings?: Array<Record<string, unknown>>;
  fail?: boolean;
}) {
  const executed: Array<{ sql: string; values: unknown[] }> = [];
  return {
    executed,
    prepare(sql: string) {
      const run = (...values: unknown[]) => ({
        all: <T>() => {
          executed.push({ sql, values });
          if (tables.fail) return Promise.reject(new Error("d1 down"));
          if (sql.includes("FROM api_configs")) {
            const rows = (tables.apiConfigs ?? []).filter(
              (r) => r.provider === values[0] && r.is_active === 1,
            );
            return Promise.resolve({ results: rows as unknown as T[] });
          }
          return Promise.resolve({ results: [] as unknown as T[] });
        },
        first: <T>() => {
          executed.push({ sql, values });
          if (tables.fail) return Promise.reject(new Error("d1 down"));
          if (sql.includes("FROM provider_settings")) {
            const row = (tables.settings ?? []).find((r) => r.provider === values[0]) ?? null;
            return Promise.resolve(row as unknown as T);
          }
          return Promise.resolve(null as unknown as T);
        },
        run: () => {
          executed.push({ sql, values });
          if (tables.fail) return Promise.reject(new Error("d1 down"));
          return Promise.resolve({ meta: {} });
        },
      });
      return { bind: run };
    },
  };
}

const d1Entry = (over: Partial<ProviderKeyEntry>): ProviderKeyEntry => ({
  key: "k",
  model: null,
  rpmLimit: null,
  source: "d1",
  keyId: 1,
  ...over,
});

describe("getProviderState", () => {
  beforeEach(() => invalidateProviderCache());

  it("prefers D1 rows and attaches row ids as keyId", async () => {
    const db = makeDb({
      apiConfigs: [
        { provider: "groq", id: 11, api_key: "g1", is_active: 1, model: "m1", rpm_limit: 5 },
        { provider: "groq", id: 12, api_key: "g2", is_active: 1, model: null, rpm_limit: null },
        { provider: "groq", id: 13, api_key: "g3", is_active: 0, model: null, rpm_limit: null }, // disabled: excluded
      ],
    });
    const state = await getProviderState({ DB: db }, "groq");
    expect(state.keys.map((k) => k.key)).toEqual(["g1", "g2"]);
    expect(state.keys[0]).toMatchObject({ source: "d1", keyId: 11, model: "m1", rpmLimit: 5 });
    expect(state.enabled).toBe(true);
  });

  it("falls back to env secrets when D1 has no keys for the provider", async () => {
    const db = makeDb({ apiConfigs: [] });
    const env = { DB: db, GEMINI_API_KEY: "e1", GEMINI_API_KEY_2: "e2" };
    const state = await getProviderState(env, "gemini");
    expect(state.keys.map((k) => k.key)).toEqual(["e1", "e2"]);
    expect(state.keys.every((k) => k.source === "env")).toBe(true);
  });

  it("keeps env fallback keys out when D1 rows exist (no mixing)", async () => {
    const db = makeDb({
      apiConfigs: [{ provider: "zhipu", id: 5, api_key: "z1", is_active: 1, model: null, rpm_limit: null }],
    });
    const env = { DB: db, ZHIPU_API_KEY: "envKey" };
    const state = await getProviderState(env, "zhipu");
    expect(state.keys.map((k) => k.key)).toEqual(["z1"]);
  });

  it("falls back to env keys when D1 errors, without caching the result", async () => {
    const db = makeDb({ fail: true });
    const env = { DB: db, NVIDIA_API_KEY: "n1" };
    const first = await getProviderState(env, "nvidia");
    expect(first.keys.map((k) => k.key)).toEqual(["n1"]);
    // Recovery: a fixed DB is picked up immediately (error path is not cached)
    const fixed = makeDb({
      apiConfigs: [{ provider: "nvidia", id: 9, api_key: "nD1", is_active: 1, model: null, rpm_limit: null }],
    });
    const second = await getProviderState({ DB: fixed }, "nvidia");
    expect(second.keys.map((k) => k.key)).toEqual(["nD1"]);
  });

  it("applies provider_settings (default model, total rpm, enabled flag)", async () => {
    const db = makeDb({
      apiConfigs: [{ provider: "mistral", id: 2, api_key: "m1", is_active: 1, model: null, rpm_limit: null }],
      settings: [{ provider: "mistral", default_model: "mistral-small-latest", rpm_total: 42, enabled: 1 }],
    });
    const state = await getProviderState({ DB: db }, "mistral");
    expect(state.defaultModel).toBe("mistral-small-latest");
    expect(state.rpmTotal).toBe(42);
    expect(state.enabled).toBe(true);
  });

  it("reports disabled providers as unusable", async () => {
    const db = makeDb({
      apiConfigs: [{ provider: "openrouter", id: 3, api_key: "o1", is_active: 1, model: null, rpm_limit: null }],
      settings: [{ provider: "openrouter", default_model: null, rpm_total: null, enabled: 0 }],
    });
    const state = await getProviderState({ DB: db }, "openrouter");
    expect(state.enabled).toBe(false);
    expect(isProviderUsable(state)).toBe(false);
  });

  it("uses env-only state when no DB binding exists", async () => {
    const env = { DEEPSEEK_API_KEY: "d1" };
    const state = await getProviderState(env, "deepseek");
    expect(state.keys.map((k) => k.key)).toEqual(["d1"]);
    expect(state.keys[0].source).toBe("env");
  });

  it("caches state for 30s and honors cache invalidation", async () => {
    const dbA = makeDb({
      apiConfigs: [{ provider: "groq", id: 1, api_key: "A", is_active: 1, model: null, rpm_limit: null }],
    });
    const env = { DB: dbA };
    const first = await getProviderState(env, "groq");
    expect(first.keys[0].key).toBe("A");
    // Second call within TTL: served from cache even with different backing data
    const dbB = makeDb({
      apiConfigs: [{ provider: "groq", id: 2, api_key: "B", is_active: 1, model: null, rpm_limit: null }],
    });
    const cached = await getProviderState({ DB: dbB }, "groq");
    expect(cached.keys[0].key).toBe("A");
    // Panel write invalidates: next call sees the new row
    invalidateProviderCache("groq");
    const fresh = await getProviderState({ DB: dbB }, "groq");
    expect(fresh.keys[0].key).toBe("B");
  });
});

describe("noteProviderKeyError / noteProviderKeySuccess", () => {
  it("writes errors only to D1-sourced keys", async () => {
    const db = makeDb({});
    await noteProviderKeyError({ DB: db }, "groq", d1Entry({ keyId: 7 }), "HTTP 429 on llama");
    expect(db.executed.some((e) => e.sql.includes("UPDATE api_configs") && e.values[0] === "HTTP 429 on llama" && e.values[1] === 7)).toBe(true);

    const envEntry = d1Entry({ source: "env", keyId: 3 });
    const db2 = makeDb({});
    await noteProviderKeyError({ DB: db2 }, "groq", envEntry, "boom");
    expect(db2.executed.filter((e) => e.sql.includes("UPDATE")).length).toBe(0);
  });

  it("clears the error and stamps last_used_at on success", async () => {
    const db = makeDb({});
    await noteProviderKeySuccess({ DB: db }, "gemini", d1Entry({ keyId: 4 }));
    expect(db.executed.some((e) => e.sql.includes("last_error = NULL") && e.values[0] === 4)).toBe(true);
  });
});

describe("keyHealthName", () => {
  it("names cooldown rows after provider and keyId", () => {
    expect(keyHealthName("groq", d1Entry({ keyId: 12 }))).toBe("groq:12");
  });
});
