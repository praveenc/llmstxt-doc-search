import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const state = vi.hoisted(() => ({ cap: 3 }));
const mocks = vi.hoisted(() => ({
  fetchAndClean: vi.fn(),
  parseLlmsTxt: vi.fn(),
}));

vi.mock("../src/config.js", () => ({
  get PAGE_CACHE_MAX() {
    return state.cap;
  },
  INDEX_RETRY_BACKOFF_MS: 60_000,
}));

vi.mock("../src/utils/doc-fetcher.js", () => ({
  fetchAndClean: mocks.fetchAndClean,
  parseLlmsTxt: mocks.parseLlmsTxt,
}));

import { ensureSourceIndexed, ensurePage, dropSourceState, getSourceState, SourceState } from "../src/utils/store.js";
import { Source } from "../src/utils/registry.js";

const ORIGIN = "https://docs.example.com/";
const urlOf = (i: number) => `${ORIGIN}page-${i}.md`;

/** Index a source seeded with `n` known URLs, returning its fresh state. */
async function indexedSource(name: string, n: number): Promise<SourceState> {
  dropSourceState(name);
  mocks.parseLlmsTxt.mockResolvedValueOnce(
    Array.from({ length: n }, (_, i) => [`Page ${i}`, urlOf(i)] as [string, string])
  );
  const src: Source = { name, url: `${ORIGIN}llms.txt` };
  return ensureSourceIndexed(src);
}

const nonNullPages = (st: SourceState) => [...st.urlCache.values()].filter((v) => v !== null).length;

beforeEach(() => {
  state.cap = 3;
  mocks.fetchAndClean.mockReset();
  mocks.parseLlmsTxt.mockReset();
  mocks.fetchAndClean.mockImplementation(async (url: string) => ({
    url,
    title: `Title ${url}`,
    content: `body of ${url}`,
  }));
});

describe("ensurePage LRU page cache (issue #4)", () => {
  it("seeds a null placeholder per known URL and counts none against the cap", async () => {
    const st = await indexedSource("seed", 5);
    expect(st.urlCache.size).toBe(5);
    expect(nonNullPages(st)).toBe(0);
    expect(st.pageLru.size).toBe(0);
  });

  it("keeps the fetched-page cache within the cap", async () => {
    const st = await indexedSource("bounded", 5);
    for (let i = 0; i < 5; i++) await ensurePage(st, urlOf(i));

    expect(st.pageLru.size).toBe(3);
    expect(nonNullPages(st)).toBe(3);
    // Evicted entries stay as null placeholders, so no known URL is dropped.
    expect(st.urlCache.size).toBe(5);
  });

  it("evicts least-recently-used and re-fetches an evicted URL on next access", async () => {
    const st = await indexedSource("evict", 5);
    for (let i = 0; i < 5; i++) await ensurePage(st, urlOf(i)); // fetch 0..4, evict 0,1
    expect(mocks.fetchAndClean).toHaveBeenCalledTimes(5);

    expect(st.urlCache.get(urlOf(0))).toBeNull();
    expect(st.urlCache.get(urlOf(1))).toBeNull();

    const page0 = await ensurePage(st, urlOf(0)); // miss -> re-fetch, evict next-oldest (2)
    expect(page0?.content).toBe(`body of ${urlOf(0)}`);
    expect(mocks.fetchAndClean).toHaveBeenCalledTimes(6);
    expect(st.pageLru.size).toBe(3);
    expect(st.urlCache.get(urlOf(2))).toBeNull();
  });

  it("a cache hit refreshes recency so the touched page is not the next evicted", async () => {
    state.cap = 2;
    const st = await indexedSource("recency", 3);
    await ensurePage(st, urlOf(0)); // [0]
    await ensurePage(st, urlOf(1)); // [0,1]
    await ensurePage(st, urlOf(0)); // hit -> [1,0]
    await ensurePage(st, urlOf(2)); // miss -> evict LRU (1), [0,2]

    expect(mocks.fetchAndClean).toHaveBeenCalledTimes(3); // url0 hit, not re-fetched
    expect(st.urlCache.get(urlOf(1))).toBeNull();
    expect(st.urlCache.get(urlOf(0))).not.toBeNull();
    expect(st.urlCache.get(urlOf(2))).not.toBeNull();
  });

  it("does not retain or count a failed fetch", async () => {
    const st = await indexedSource("failure", 3);
    mocks.fetchAndClean.mockRejectedValueOnce(new Error("boom"));

    const page = await ensurePage(st, urlOf(0));
    expect(page).toBeNull();
    expect(st.urlCache.get(urlOf(0))).toBeNull();
    expect(st.pageLru.has(urlOf(0))).toBe(false);
    expect(st.pageLru.size).toBe(0);
  });

  it("disables eviction when the cap is 0", async () => {
    state.cap = 0;
    const st = await indexedSource("unbounded", 5);
    for (let i = 0; i < 5; i++) await ensurePage(st, urlOf(i));

    expect(st.pageLru.size).toBe(5);
    expect(nonNullPages(st)).toBe(5);
  });
});

describe("page-cache keys for URLs not in the llms.txt (issue #19)", () => {
  const unlisted = (i: number) => `${ORIGIN}search?q=${i}`;

  it("does not keep a key for an unlisted URL whose fetch failed", async () => {
    const st = await indexedSource("fail-unlisted", 2);
    mocks.fetchAndClean.mockRejectedValueOnce(new Error("HTTP 404"));

    expect(await ensurePage(st, unlisted(0))).toBeNull();
    expect(st.urlCache.has(unlisted(0))).toBe(false);
    expect(st.urlCache.size).toBe(2);
  });

  it("keeps a listed URL's placeholder when its fetch fails", async () => {
    const st = await indexedSource("fail-listed", 2);
    mocks.fetchAndClean.mockRejectedValueOnce(new Error("HTTP 500"));

    expect(await ensurePage(st, urlOf(0))).toBeNull();
    expect(st.urlCache.has(urlOf(0))).toBe(true);
    expect(st.urlCache.get(urlOf(0))).toBeNull();
  });

  it("removes an evicted unlisted URL but keeps an evicted listed one", async () => {
    state.cap = 1;
    const st = await indexedSource("evict-mixed", 2);
    await ensurePage(st, unlisted(0)); // [u0]
    await ensurePage(st, urlOf(0)); // evicts u0 -> removed
    expect(st.urlCache.has(unlisted(0))).toBe(false);
    await ensurePage(st, urlOf(1)); // evicts listed 0 -> placeholder
    expect(st.urlCache.has(urlOf(0))).toBe(true);
    expect(st.urlCache.get(urlOf(0))).toBeNull();
  });

  it("stays bounded by the listed URLs plus the cap however many variants are fetched", async () => {
    const st = await indexedSource("bounded-keys", 5);
    for (let i = 0; i < 120; i++) await ensurePage(st, unlisted(i));
    mocks.fetchAndClean.mockRejectedValue(new Error("HTTP 404"));
    for (let i = 120; i < 150; i++) await ensurePage(st, unlisted(i));

    expect(st.urlCache.size).toBe(5 + 3); // 5 listed placeholders + cap of 3 cached pages
    expect(st.pageLru.size).toBe(3);
  });

  it("an evicted unlisted URL is fetched again on next access", async () => {
    state.cap = 1;
    const st = await indexedSource("refetch-unlisted", 1);
    await ensurePage(st, unlisted(0));
    await ensurePage(st, unlisted(1)); // evicts u0
    const again = await ensurePage(st, unlisted(0));
    expect(again?.content).toBe(`body of ${unlisted(0)}`);
    expect(mocks.fetchAndClean).toHaveBeenCalledTimes(3);
  });
});

describe("ensureSourceIndexed with alternate titles", () => {
  it("indexes one doc per URL and keeps alternate titles searchable", async () => {
    dropSourceState("alt");
    mocks.parseLlmsTxt.mockResolvedValueOnce([
      ["Pause for input and control", `${ORIGIN}hitl/index.md`, ["Human in the loop"]],
      ["Agent loop", `${ORIGIN}agent-loop/index.md`],
    ]);
    const st = await ensureSourceIndexed({ name: "alt", url: `${ORIGIN}llms.txt` } as Source);

    expect(st.docCount).toBe(2);
    const hits = st.index.search("human in the loop", 5);
    expect(hits[0].doc.uri).toBe(`${ORIGIN}hitl/index.md`);
    expect(hits[0].doc.displayTitle).toBe("Pause for input and control");
    expect(hits.filter((h) => h.doc.uri === `${ORIGIN}hitl/index.md`)).toHaveLength(1);
  });
});

describe("ensureSourceIndexed failure backoff (issue #12)", () => {
  const src = { name: "broken", url: `${ORIGIN}llms.txt` } as Source;

  beforeEach(() => {
    dropSourceState("broken");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("records the failure and names the source", async () => {
    mocks.parseLlmsTxt.mockRejectedValueOnce(new Error("HTTP 404"));
    await expect(ensureSourceIndexed(src)).rejects.toThrow(
      "source 'broken' failed to index: HTTP 404 (retry in 60s, or call refresh_doc_source)"
    );

    const st = getSourceState("broken");
    expect(st?.indexed).toBe(false);
    expect(st?.lastError).toBe("HTTP 404");
    expect(st?.failedAt).toBe(Date.now());
  });

  it("fails fast within the backoff without re-fetching the llms.txt", async () => {
    mocks.parseLlmsTxt.mockRejectedValueOnce(new Error("HTTP 404"));
    await expect(ensureSourceIndexed(src)).rejects.toThrow();

    vi.advanceTimersByTime(30_000);
    await expect(ensureSourceIndexed(src)).rejects.toThrow(/HTTP 404 \(retry in 30s, or call refresh_doc_source\)/);
    expect(mocks.parseLlmsTxt).toHaveBeenCalledTimes(1);
  });

  it("retries after the backoff and clears the failure on success", async () => {
    mocks.parseLlmsTxt.mockRejectedValueOnce(new Error("HTTP 404"));
    await expect(ensureSourceIndexed(src)).rejects.toThrow();

    vi.advanceTimersByTime(60_000);
    mocks.parseLlmsTxt.mockResolvedValueOnce([["Page 0", urlOf(0)]]);
    const st = await ensureSourceIndexed(src);
    expect(mocks.parseLlmsTxt).toHaveBeenCalledTimes(2);
    expect(st.indexed).toBe(true);
    expect(st.lastError).toBeUndefined();
    expect(st.failedAt).toBeUndefined();
  });

  it("retries immediately once the state is dropped", async () => {
    mocks.parseLlmsTxt.mockRejectedValueOnce(new Error("HTTP 404"));
    await expect(ensureSourceIndexed(src)).rejects.toThrow();

    dropSourceState("broken");
    mocks.parseLlmsTxt.mockResolvedValueOnce([["Page 0", urlOf(0)]]);
    expect((await ensureSourceIndexed(src)).indexed).toBe(true);
  });

  it("gives a readable reason when the error message is empty", async () => {
    mocks.parseLlmsTxt.mockRejectedValueOnce(new Error(""));
    await expect(ensureSourceIndexed(src)).rejects.toThrow("source 'broken' failed to index: Error");
    expect(getSourceState("broken")?.lastError).toBe("Error");
  });
});

describe("URL extension is not a search term (issue #18)", () => {
  it("a search for 'md' does not match every page of a .md site", async () => {
    dropSourceState("mdsite");
    mocks.parseLlmsTxt.mockResolvedValueOnce([
      ["Global CLI", `${ORIGIN}guide/global-cli.md`],
      ["Caching", `${ORIGIN}guide/cache.md`],
      ["Markdown files (md)", `${ORIGIN}guide/markdown.md`],
    ]);
    const st = await ensureSourceIndexed({ name: "mdsite", url: `${ORIGIN}llms.txt` } as Source);
    expect(st.index.search("md", 10).map((h) => h.doc.uri)).toEqual([`${ORIGIN}guide/markdown.md`]);
  });
});
