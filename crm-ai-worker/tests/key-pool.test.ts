import { describe, it, expect } from "vitest";
import { collectKeyPool, buildKeyOrder } from "../src/key-pool";
import { keyHealthName } from "../src/provider-keys";

describe("collectKeyPool", () => {
  it("collects indexed keys in order and skips unset slots", () => {
    const env = {
      GROQ_API_KEY: "k1",
      GROQ_API_KEY_2: "   ", // blank: treated as unset
      GROQ_API_KEY_4: "k4",
    };
    expect(collectKeyPool(env, "GROQ")).toEqual(["k1", "k4"]);
  });

  it("trims whitespace around key values", () => {
    const env = { FOO_API_KEY: "  abc  ", FOO_API_KEY_2: "\tdef\n" };
    expect(collectKeyPool(env, "FOO")).toEqual(["abc", "def"]);
  });

  it("stops at maxKeys and ignores non-string values", () => {
    const env = {
      X_API_KEY: "a",
      X_API_KEY_2: 42, // number: ignored
      X_API_KEY_3: "c",
      X_API_KEY_4: "d",
    };
    expect(collectKeyPool(env, "X", 3)).toEqual(["a", "c"]);
  });

  it("returns an empty array when nothing is set", () => {
    expect(collectKeyPool({}, "NOPE")).toEqual([]);
  });
});

describe("buildKeyOrder", () => {
  const entries = [{ key: "a" }, { key: "b" }, { key: "c" }, { key: "d" }];
  const healthNames = ["p:1", "p:2", "p:3", "p:4"];

  it("starts rotation at startIndex (anti-ban: one key per task)", () => {
    const order = buildKeyOrder(entries, healthNames, 2, new Set());
    expect(order.map((o) => o.apiKey)).toEqual(["c", "d", "a", "b"]);
    expect(order[0].healthName).toBe("p:3");
  });

  it("excludes exhausted keys by health name", () => {
    const order = buildKeyOrder(entries, healthNames, 0, new Set(["p:1", "p:3"]));
    expect(order.map((o) => o.healthName)).toEqual(["p:2", "p:4"]);
  });

  it("returns empty when every key is exhausted", () => {
    const all = new Set(healthNames);
    expect(buildKeyOrder(entries, healthNames, 0, all)).toEqual([]);
  });

  it("handles negative startIndex without throwing", () => {
    const order = buildKeyOrder(entries, healthNames, -3, new Set());
    expect(order).toHaveLength(4);
    expect(new Set(order.map((o) => o.apiKey))).toEqual(new Set(["a", "b", "c", "d"]));
  });

  it("keeps entries and health names aligned", () => {
    const order = buildKeyOrder(entries, healthNames, 1, new Set(["p:2"]));
    for (const attempt of order) {
      expect(attempt.healthName).toBe(healthNames[entries.findIndex((e) => e.key === attempt.apiKey)]);
    }
  });
});

describe("keyHealthName", () => {
  it("uses the provider:keyId form for both sources", () => {
    const d1 = { key: "k", model: null, rpmLimit: null, source: "d1" as const, keyId: 17 };
    const env = { key: "k", model: null, rpmLimit: null, source: "env" as const, keyId: 3 };
    expect(keyHealthName("groq", d1)).toBe("groq:17");
    expect(keyHealthName("groq", env)).toBe("groq:3");
  });
});
