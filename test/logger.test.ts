import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { formatLogArg, logger, setLogLevel } from "../src/utils/logger.js";

describe("formatLogArg", () => {
  it("renders an Error as name: message instead of {}", () => {
    expect(formatLogArg(new Error("HTTP 404"))).toBe("Error: HTTP 404");
    expect(formatLogArg(new TypeError("bad input"))).toBe("TypeError: bad input");
  });

  it("falls back to the name when the message is empty", () => {
    expect(formatLogArg(new Error(""))).toBe("Error");
  });

  it("adds the error code when present", () => {
    const e = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), { code: "ECONNREFUSED" });
    expect(formatLogArg(e)).toBe("Error: connect ECONNREFUSED 127.0.0.1:443 (code=ECONNREFUSED)");
  });

  it("includes the cause chain", () => {
    const e = new Error("source 'x' failed to index", { cause: new Error("HTTP 404") });
    expect(formatLogArg(e)).toBe("Error: source 'x' failed to index (cause: Error: HTTP 404)");
  });

  it("includes AggregateError sub-errors, whose own message is often empty", () => {
    const inner = Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" });
    const agg = Object.assign(new AggregateError([inner], ""), { code: "ETIMEDOUT" });
    expect(formatLogArg(agg)).toBe("AggregateError (code=ETIMEDOUT) [Error: connect ETIMEDOUT (code=ETIMEDOUT)]");
  });

  it("stops following causes past a fixed depth", () => {
    let e = new Error("level 0");
    for (let i = 1; i <= 10; i++) e = new Error(`level ${i}`, { cause: e });
    const out = formatLogArg(e);
    expect(out).toContain("level 10");
    expect(out).toContain("level 7");
    expect(out).not.toContain("level 6");
  });

  it("keeps strings as-is and JSON-encodes other values", () => {
    expect(formatLogArg("plain")).toBe("plain");
    expect(formatLogArg({ a: 1 })).toBe('{"a":1}');
    expect(formatLogArg(42)).toBe("42");
    expect(formatLogArg(undefined)).toBe("undefined");
  });

  it("does not throw on circular values", () => {
    const o: Record<string, unknown> = {};
    o.self = o;
    expect(formatLogArg(o)).toBe("[object Object]");
  });
});

describe("logger output", () => {
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    setLogLevel("debug");
    spy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    spy.mockRestore();
    setLogLevel("info");
  });

  it("writes the error text to stderr", () => {
    logger.warn("fetch failed: https://docs.example.com/a.md", new Error("HTTP 500"));
    expect(spy).toHaveBeenCalledTimes(1);
    const line = String(spy.mock.calls[0][0]);
    expect(line).toMatch(/\[WARN\] fetch failed: https:\/\/docs\.example\.com\/a\.md Error: HTTP 500$/);
    expect(line).not.toContain("{}");
  });

  it("joins several arguments with spaces", () => {
    logger.error("boom", "context", new Error("x"));
    expect(String(spy.mock.calls[0][0])).toMatch(/boom context Error: x$/);
  });

  it("prints the bare message when there are no arguments", () => {
    logger.info("ready");
    expect(String(spy.mock.calls[0][0])).toMatch(/\[INFO\] ready$/);
  });

  it("respects the log level", () => {
    setLogLevel("error");
    logger.warn("hidden", new Error("x"));
    expect(spy).not.toHaveBeenCalled();
  });
});
