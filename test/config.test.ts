import { describe, it, expect, afterEach, vi } from "vitest";

const KEY = "LLMSTXT_PAGE_CACHE_MAX";
const original = process.env[KEY];

/** Re-import config with a given env value (or unset) and read the parsed cap. */
async function capFor(value: string | undefined): Promise<number> {
  vi.resetModules();
  if (value === undefined) delete process.env[KEY];
  else process.env[KEY] = value;
  const mod = await import("../src/config.js");
  return mod.PAGE_CACHE_MAX;
}

afterEach(() => {
  if (original === undefined) delete process.env[KEY];
  else process.env[KEY] = original;
});

describe("PAGE_CACHE_MAX parsing (LLMSTXT_PAGE_CACHE_MAX)", () => {
  it("defaults to 50 when unset", async () => {
    expect(await capFor(undefined)).toBe(50);
  });

  it("defaults to 50 for an empty or whitespace value", async () => {
    expect(await capFor("")).toBe(50);
    expect(await capFor("   ")).toBe(50);
  });

  it("parses a positive integer", async () => {
    expect(await capFor("10")).toBe(10);
  });

  it("floors a fractional value", async () => {
    expect(await capFor("2.9")).toBe(2);
  });

  it("accepts 0 to disable the cap", async () => {
    expect(await capFor("0")).toBe(0);
  });

  it("falls back to 50 for negative or non-numeric values", async () => {
    expect(await capFor("-1")).toBe(50);
    expect(await capFor("abc")).toBe(50);
  });
});
