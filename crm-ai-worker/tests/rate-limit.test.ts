import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  PER_KEY_RPM,
  rpmLimitFor,
  rpmEnvOverride,
  tryAcquireRpmSlot,
  resetRpmBuckets,
} from "../src/rate-limit";

describe("rpmLimitFor", () => {
  it("scales the per-key cap by pool size", () => {
    expect(rpmLimitFor("groq", 3)).toBe(PER_KEY_RPM.groq * 3);
  });

  it("uses at least one key worth of capacity", () => {
    expect(rpmLimitFor("gemini", 0)).toBe(PER_KEY_RPM.gemini);
    expect(rpmLimitFor("gemini", -5)).toBe(PER_KEY_RPM.gemini);
  });

  it("prefers the explicit total override when valid", () => {
    expect(rpmLimitFor("groq", 10, "40")).toBe(40);
  });

  it("ignores invalid overrides (zero, negative, garbage)", () => {
    expect(rpmLimitFor("groq", 2, "0")).toBe(PER_KEY_RPM.groq * 2);
    expect(rpmLimitFor("groq", 2, "-3")).toBe(PER_KEY_RPM.groq * 2);
    expect(rpmLimitFor("groq", 2, "abc")).toBe(PER_KEY_RPM.groq * 2);
    expect(rpmLimitFor("groq", 2, undefined)).toBe(PER_KEY_RPM.groq * 2);
  });
});

describe("rpmEnvOverride", () => {
  it("reads the matching provider secret", () => {
    const env = { GROQ_RPM: "42", GEMINI_RPM: "7" };
    expect(rpmEnvOverride(env, "groq")).toBe("42");
    expect(rpmEnvOverride(env, "gemini")).toBe("7");
    expect(rpmEnvOverride(env, "zhipu")).toBeUndefined();
  });
});

describe("tryAcquireRpmSlot", () => {
  beforeEach(() => resetRpmBuckets());

  it("allows requests under the cap and blocks at the cap", () => {
    // limit 3: first three pass, fourth is rejected
    expect(tryAcquireRpmSlot("groq", 3)).toBe(true);
    expect(tryAcquireRpmSlot("groq", 3)).toBe(true);
    expect(tryAcquireRpmSlot("groq", 3)).toBe(true);
    expect(tryAcquireRpmSlot("groq", 3)).toBe(false);
  });

  it("tracks providers independently", () => {
    expect(tryAcquireRpmSlot("gemini", 1)).toBe(true);
    expect(tryAcquireRpmSlot("gemini", 1)).toBe(false);
    // groq unaffected by gemini's exhausted slot
    expect(tryAcquireRpmSlot("groq", 5)).toBe(true);
  });

  it("recovers after the sliding window passes", () => {
    expect(tryAcquireRpmSlot("zhipu", 1)).toBe(true);
    expect(tryAcquireRpmSlot("zhipu", 1)).toBe(false);
    // Backdate every recorded timestamp beyond the 60s window.
    vi.useFakeTimers();
    try {
      vi.advanceTimersByTime(61_000);
      expect(tryAcquireRpmSlot("zhipu", 1)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
