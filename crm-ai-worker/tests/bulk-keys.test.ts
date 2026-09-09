import { describe, it, expect } from "vitest";
import { parseBulkKeyEntries } from "../src/bulk-keys";

describe("parseBulkKeyEntries", () => {
  it("parses key,label lines and keeps commas inside labels", () => {
    const raw = "tvly-abcdef123456,账号1\ntvly-ghijkl789012,采购部,备用\n";
    expect(parseBulkKeyEntries(raw)).toEqual([
      { key: "tvly-abcdef123456", label: "账号1" },
      { key: "tvly-ghijkl789012", label: "采购部,备用" },
    ]);
  });

  it("parses Excel/Sheets tab-separated two-column paste", () => {
    const raw = "tvly-abcdef123456\t账号1\ntvly-ghijkl789012\t账号2";
    expect(parseBulkKeyEntries(raw)).toEqual([
      { key: "tvly-abcdef123456", label: "账号1" },
      { key: "tvly-ghijkl789012", label: "账号2" },
    ]);
  });

  it("parses pipe-separated lines", () => {
    expect(parseBulkKeyEntries("exa-abcdef123456|账号9")).toEqual([
      { key: "exa-abcdef123456", label: "账号9" },
    ]);
  });

  it("trims surrounding whitespace and quotes from labels", () => {
    const raw = 'brave-abcdef123456, "账号 1" \nbrave-ghijkl789012,\'账号2\'';
    expect(parseBulkKeyEntries(raw)).toEqual([
      { key: "brave-abcdef123456", label: "账号 1" },
      { key: "brave-ghijkl789012", label: "账号2" },
    ]);
  });

  it("handles bare keys: legacy comma/semicolon/space batches, no label", () => {
    const raw = "tvly-abcdef123456, tvly-ghijkl789012;tvly-mnopqr345678\ntvly-stuvwx901234";
    expect(parseBulkKeyEntries(raw)).toEqual([
      { key: "tvly-abcdef123456", label: null },
      { key: "tvly-ghijkl789012", label: null },
      { key: "tvly-mnopqr345678", label: null },
      { key: "tvly-stuvwx901234", label: null },
    ]);
  });

  it("dedupes identical keys within the paste", () => {
    const raw = "tvly-abcdef123456,账号1\ntvly-abcdef123456,账号2";
    expect(parseBulkKeyEntries(raw)).toEqual([{ key: "tvly-abcdef123456", label: "账号1" }]);
  });

  it("drops keys shorter than 8 chars (noise/placeholders)", () => {
    const raw = "short,账号1\ntvly-abcdef123456,账号2";
    expect(parseBulkKeyEntries(raw)).toEqual([{ key: "tvly-abcdef123456", label: "账号2" }]);
  });

  it("skips blank lines and trims CRLF", () => {
    const raw = "\r\ntvly-abcdef123456,账号1\r\n\r\ntvly-ghijkl789012,账号2\r\n";
    expect(parseBulkKeyEntries(raw)).toHaveLength(2);
  });

  it("returns empty for garbage input", () => {
    expect(parseBulkKeyEntries("")).toEqual([]);
    expect(parseBulkKeyEntries("short\n1234")).toEqual([]);
  });
});
