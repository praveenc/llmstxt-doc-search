import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { stem, PorterStemmer } from "../src/utils/porter-stemmer.js";
import { tokenize } from "../src/utils/indexer.js";

const stemmerFixture = JSON.parse(
  readFileSync(new URL("./fixtures/stemmer-parity.json", import.meta.url), "utf8")
) as { count: number; pairs: [string, string][] };

const tokenizeFixture = JSON.parse(
  readFileSync(new URL("./fixtures/tokenize-parity.json", import.meta.url), "utf8")
) as { count: number; pairs: [string, string[]][] };

describe("porter stemmer parity with natural", () => {
  it("matches natural.PorterStemmer.stem for every fixture word", () => {
    expect(stemmerFixture.pairs.length).toBeGreaterThanOrEqual(2000);
    const mismatches: [string, string, string][] = [];
    for (const [word, expected] of stemmerFixture.pairs) {
      const got = stem(word);
      if (got !== expected) mismatches.push([word, expected, got]);
    }
    // The vendored stemmer is a faithful port of natural's, so parity is exact.
    // If a word ever legitimately diverges it should be listed here with a note.
    expect(mismatches).toEqual([]);
  });

  it("exposes a PorterStemmer.stem drop-in", () => {
    expect(PorterStemmer.stem("running")).toBe("run");
    expect(PorterStemmer.stem("nationalization")).toBe("nation");
    expect(PorterStemmer.stem("organizer")).toBe("organ");
  });

  it("returns tokens shorter than 3 characters unchanged", () => {
    expect(stem("a")).toBe("a");
    expect(stem("go")).toBe("go");
    expect(stem("s3")).toBe("s3");
  });
});

describe("tokenize parity", () => {
  it("matches the captured tokenize output for every fixture string", () => {
    expect(tokenizeFixture.pairs.length).toBeGreaterThanOrEqual(200);
    const mismatches: { input: string; expected: string[]; got: string[] }[] = [];
    for (const [input, expected] of tokenizeFixture.pairs) {
      const got = tokenize(input);
      if (JSON.stringify(got) !== JSON.stringify(expected)) {
        mismatches.push({ input, expected, got });
      }
    }
    expect(mismatches).toEqual([]);
  });
});
