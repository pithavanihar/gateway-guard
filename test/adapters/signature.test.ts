import { describe, expect, it } from "vitest";
import { headerValue, isRecord, safeEqual } from "../../src/adapters/signature.js";

describe("signature helpers", () => {
  it("headerValue matches any casing and treats empty or repeated headers as absent", () => {
    expect(headerValue({ "X-Sig": "abc" }, "x-sig")).toBe("abc");
    expect(headerValue({ "x-sig": "abc" }, "X-Sig")).toBe("abc");
    expect(headerValue({ "x-sig": ["abc"] }, "x-sig")).toBe("abc");
    expect(headerValue({ "x-sig": ["a", "b"] }, "x-sig")).toBeUndefined();
    expect(headerValue({ "x-sig": "" }, "x-sig")).toBeUndefined();
    expect(headerValue({ "x-sig": undefined }, "x-sig")).toBeUndefined();
    expect(headerValue({}, "x-sig")).toBeUndefined();
  });

  it("safeEqual compares exactly and never throws on length mismatch", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("abc", "")).toBe(false);
  });

  it("isRecord accepts objects only", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord([])).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(isRecord("x")).toBe(false);
  });
});
