import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { IndexSearch, tokenize } from "../src/utils/indexer.js";

interface Doc {
  uri: string;
  displayTitle: string;
  content: string;
  indexTitle: string;
}

const searchFixture = JSON.parse(
  readFileSync(new URL("./fixtures/search-parity.json", import.meta.url), "utf8")
) as {
  docCount: number;
  docs: Doc[];
  queries: { q: string; k: number; results: { uri: string; score: number }[] }[];
};

function buildIndex(): IndexSearch {
  const ix = new IndexSearch();
  for (const d of searchFixture.docs) ix.add(d);
  return ix;
}

describe("search parity with baseline (score-preserving refactor)", () => {
  it("reproduces baseline uris and scores for every query", () => {
    const ix = buildIndex();
    expect(ix.size).toBe(searchFixture.docs.length);

    for (const query of searchFixture.queries) {
      const got = ix.search(query.q, query.k);
      const exp = query.results;
      expect(got.length, `result count for "${query.q}"`).toBe(exp.length);
      for (let i = 0; i < exp.length; i++) {
        expect(got[i].doc.uri, `uri at rank ${i} for "${query.q}"`).toBe(exp[i].uri);
        // Scores must be equal to within 1e-12 (in practice they are bit-identical).
        expect(
          Math.abs(got[i].score - exp[i].score),
          `score delta at rank ${i} for "${query.q}"`
        ).toBeLessThanOrEqual(1e-12);
      }
    }
  });

  it("exercises the weighted non-empty-content path in ranking", () => {
    const contentUris = new Set(
      searchFixture.docs.filter((d) => d.content.length > 0).map((d) => d.uri)
    );
    expect(contentUris.size).toBeGreaterThanOrEqual(20);

    const ix = buildIndex();
    let contentDocRankedTop = false;
    for (const query of searchFixture.queries) {
      const got = ix.search(query.q, query.k);
      if (got.length > 0 && contentUris.has(got[0].doc.uri)) {
        contentDocRankedTop = true;
        break;
      }
    }
    // Proves header/code/link/title weighting actually influences ranking.
    expect(contentDocRankedTop).toBe(true);
  });
});

describe("index build scaling and avgDocLength", () => {
  it("builds 20,000 title docs without the old O(n^2) blowup", () => {
    const N = 20000;
    const ix = new IndexSearch();
    const start = Date.now();
    for (let i = 0; i < N; i++) {
      ix.add({
        uri: `u${i}`,
        displayTitle: `Doc ${i}`,
        content: "",
        indexTitle: `document number ${i} alpha beta gamma delta`,
      });
    }
    const elapsedMs = Date.now() - start;
    expect(ix.size).toBe(N);
    // Generous bound: the O(1)-per-add running total finishes in well under a
    // second; the old full-reduce-per-add (O(n^2)) grows steeply past this.
    expect(elapsedMs).toBeLessThan(8000);
  });

  it("computes avgDocLength as total tokens / doc count on a known corpus", () => {
    const docs: Doc[] = [
      { uri: "a", displayTitle: "", content: "", indexTitle: "alpha beta gamma" },
      { uri: "b", displayTitle: "", content: "", indexTitle: "zebra quokka" },
      { uri: "c", displayTitle: "", content: "", indexTitle: "singleton" },
    ];
    const ix = new IndexSearch();
    for (const d of docs) ix.add(d);

    // Private fields are runtime-visible; read them for a white-box assertion.
    const internals = ix as unknown as { docLengths: number[]; totalDocLength: number; avgDocLength: number };
    const lengths = internals.docLengths;

    // With empty content the haystack is just the (lowercased) indexTitle, so
    // docLength = unigrams + bigrams = (u === 0 ? 0 : 2u - 1).
    for (let i = 0; i < docs.length; i++) {
      const u = tokenize(docs[i].indexTitle).length;
      const expectedLen = u === 0 ? 0 : 2 * u - 1;
      expect(lengths[i], `docLength for doc ${i}`).toBe(expectedLen);
    }

    const total = lengths.reduce((a, b) => a + b, 0);
    expect(internals.totalDocLength).toBe(total);
    expect(internals.avgDocLength).toBeCloseTo(total / docs.length, 12);
  });
});
