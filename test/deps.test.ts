import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

describe("dependency hygiene", () => {
  it("declares no dependency on natural", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8")
    ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    expect(pkg.dependencies?.natural).toBeUndefined();
    expect(pkg.devDependencies?.natural).toBeUndefined();
  });

  it("importing the indexer does not write to process.stdout", async () => {
    // natural's dotenv dependency printed to stdout on import, corrupting the
    // stdio JSON-RPC channel. With the vendored stemmer, importing the indexer
    // (and its transitive imports) must be silent on stdout.
    const writes: unknown[] = [];
    const original = process.stdout.write.bind(process.stdout);
    (process.stdout as unknown as { write: (...a: unknown[]) => boolean }).write = (
      chunk: unknown
    ) => {
      writes.push(chunk);
      return true;
    };
    try {
      // First import of the indexer in this (isolated) test module executes its
      // top-level code and its import chain.
      await import("../src/utils/indexer.js");
    } finally {
      (process.stdout as unknown as { write: typeof original }).write = original;
    }
    expect(writes.map(String).join("")).toBe("");
  });
});
