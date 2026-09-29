import { describe, it, expect, beforeEach, vi } from "vitest";

const state = vi.hoisted(() => ({ cap: 3 }));
const mocks = vi.hoisted(() => ({
  fetchAndClean: vi.fn(),
  parseLlmsTxt: vi.fn(),
}));

vi.mock("../src/config.js", () => ({
  get PAGE_CACHE_MAX() {
    return state.cap;
  },
}));

vi.mock("../src/utils/doc-fetcher.js", () => ({
  fetchAndClean: mocks.fetchAndClean,
  parseLlmsTxt: mocks.parseLlmsTxt,
}));

import { ensureSourceIndexed, ensurePage, dropSourceState, SourceState } from "../src/utils/store.js";
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
