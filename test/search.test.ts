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

describe("BM25 ranking bug fixes (issue #2)", () => {
  // --- Bug 1: duplicate postings made a repeated term score once per occurrence. ---

  it("does not add duplicate posting ids for a term repeated in one document", () => {
    const ix = new IndexSearch();
    ix.add({ uri: "a", displayTitle: "", content: "", indexTitle: "Agent Agent Agent" });
    ix.add({ uri: "b", displayTitle: "", content: "", indexTitle: "Agent" });

    const postings = (ix as unknown as { docIndices: Map<string, number[]> }).docIndices.get("agent") ?? [];
    // Each document appears at most once in the posting list (was [0,0,0,1]).
    expect(postings).toEqual([0, 1]);
    expect(new Set(postings).size).toBe(postings.length);
  });

  it("saturates a repeated term instead of scaling linearly with occurrences", () => {
    const ix = new IndexSearch();
    ix.add({ uri: "a", displayTitle: "", content: "", indexTitle: "Agent Agent Agent" });
    ix.add({ uri: "b", displayTitle: "", content: "", indexTitle: "Agent" });

    const r = ix.search("agent", 8);
    const a = r.find((x) => x.doc.uri === "a")!.score;
    const b = r.find((x) => x.doc.uri === "b")!.score;

    // Before the fix a was ~3x b (one score per duplicate posting). After it,
    // BM25 saturation collapses that: two documents made entirely of the same
    // term score equally under length normalization, nowhere near 3x.
    expect(a).toBeLessThan(1.2 * b);
  });

  it("ranks more occurrences above fewer at equal length, but sub-linearly", () => {
    // Equal-length documents so length normalization does not cancel the term
    // frequency difference (with pure single-term documents it exactly does).
    const ix = new IndexSearch();
    ix.add({ uri: "a", displayTitle: "", content: "", indexTitle: "agent agent agent" });
    ix.add({ uri: "b", displayTitle: "", content: "", indexTitle: "agent model tool" });

    const r = ix.search("agent", 8);
    const a = r.find((x) => x.doc.uri === "a")!.score;
    const b = r.find((x) => x.doc.uri === "b")!.score;

    expect(a).toBeGreaterThan(b);
    // Saturated: far below the old linear 3x for three occurrences vs one.
    expect(a).toBeLessThan(3 * b);
  });

  // --- Bug 2: term frequency was counted by substring over raw text, so stems
  //     that are not substrings of the surface form, and bigram tokens (which
  //     contain "_"), never matched. ---

  function kbIndex(): IndexSearch {
    const ix = new IndexSearch();
    ix.add({ uri: "kb-phrase", displayTitle: "", content: "", indexTitle: "Query a knowledge base" });
    ix.add({ uri: "kb-nonadj", displayTitle: "", content: "", indexTitle: "knowledge overview base" });
    return ix;
  }

  it("matches a query whose stem differs from the surface form (query -> queri)", () => {
    const ix = kbIndex();
    const r = ix.search("query", 8);
    const hit = r.find((x) => x.doc.uri === "kb-phrase");
    // Was 0: "queri" is not a substring of "query a knowledge base".
    expect(hit).toBeDefined();
    expect(hit!.score).toBeGreaterThan(0);
  });

  it("scores an adjacent phrase above the sum of its individual terms", () => {
    const ix = kbIndex();
    const scoreOf = (q: string) =>
      ix.search(q, 8).find((x) => x.doc.uri === "kb-phrase")?.score ?? 0;

    const phrase = scoreOf("knowledge base");
    const parts = scoreOf("knowledge") + scoreOf("base");

    // The bigram "knowledg_base" now contributes; before it added nothing.
    expect(phrase).toBeGreaterThan(parts);
  });

  it("ranks a document with the adjacent phrase above one with the words apart", () => {
    const ix = kbIndex();
    const r = ix.search("knowledge base", 8);
    const rankOf = (uri: string) => r.findIndex((x) => x.doc.uri === uri);

    const adj = rankOf("kb-phrase");
    const nonAdj = rankOf("kb-nonadj");
    expect(adj).toBeGreaterThanOrEqual(0);
    expect(nonAdj).toBeGreaterThanOrEqual(0);
    // Lower index == higher rank.
    expect(adj).toBeLessThan(nonAdj);
  });
});
