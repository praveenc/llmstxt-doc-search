import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";

// Per-file registry, set before config.ts reads it, so parallel test files
// never share (and race on deleting) one registry file.
const TMP = vi.hoisted(() => {
  const path = `/tmp/llmstxt-test-docs-${process.pid}.json`;
  process.env.LLMSTXT_REGISTRY_PATH = path;
  return path;
});

const mocks = vi.hoisted(() => ({
  parseLlmsTxt: vi.fn(),
  fetchAndClean: vi.fn(),
}));

vi.mock("../src/utils/doc-fetcher.js", () => ({
  parseLlmsTxt: mocks.parseLlmsTxt,
  fetchAndClean: mocks.fetchAndClean,
}));

import {
  addDocSource,
  fetchDoc,
  listDocSources,
  refreshDocSource,
  searchDocs,
  topUniqueByUrl,
} from "../src/tools/docs.js";
import { addSourceEntry, getSource, getSources, _resetRegistryCache } from "../src/utils/registry.js";
import { dropSourceState, ensurePage, ensureSourceIndexed } from "../src/utils/store.js";
import { rmSync } from "node:fs";

beforeEach(() => {
  rmSync(TMP, { force: true });
  _resetRegistryCache();
  for (const s of getSources()) dropSourceState(s.name);
  mocks.parseLlmsTxt.mockReset();
  mocks.fetchAndClean.mockReset();
});

afterEach(() => {
  for (const s of getSources()) dropSourceState(s.name);
});

afterAll(() => {
  rmSync(TMP, { force: true });
});

describe("topUniqueByUrl", () => {
  it("returns one hit per URL, keeping the best score, in score order", () => {
    const hits = [
      { uri: "a", score: 5, src: "s1" },
      { uri: "b", score: 9, src: "s1" },
      { uri: "a", score: 7, src: "s2" },
      { uri: "c", score: 1, src: "s1" },
    ];
    expect(topUniqueByUrl(hits, 5)).toEqual([
      { uri: "b", score: 9, src: "s1" },
      { uri: "a", score: 7, src: "s2" },
      { uri: "c", score: 1, src: "s1" },
    ]);
  });

  it("fills k with distinct URLs rather than stopping at duplicates", () => {
    const hits = [
      { uri: "a", score: 3 },
      { uri: "a", score: 3 },
      { uri: "a", score: 3 },
      { uri: "b", score: 2 },
      { uri: "c", score: 1 },
    ];
    expect(topUniqueByUrl(hits, 2).map((h) => h.uri)).toEqual(["a", "b"]);
  });
});

describe("addDocSource", () => {
  it("rolls back a source whose llms.txt yields no links", async () => {
    dropSourceState("empty");
    mocks.parseLlmsTxt.mockRejectedValueOnce(
      new Error("no markdown links found in https://docs.example.com/llms.txt")
    );
    await expect(addDocSource("empty", "https://docs.example.com/llms.txt")).rejects.toThrow(
      "source 'empty' was not added: its llms.txt failed to index: no markdown links found in https://docs.example.com/llms.txt"
    );
    expect(getSource("empty")).toBeUndefined();
  });

  it("does not suggest refresh_doc_source for a source it rolled back (issue #36)", async () => {
    dropSourceState("gone");
    mocks.parseLlmsTxt.mockRejectedValueOnce(new Error("HTTP 404"));
    const err = await addDocSource("gone", "https://docs.example.com/llms.txt").catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toMatch(/refresh_doc_source|retry in/);
    expect((err as Error).message).toMatch(/HTTP 404$/);
    await expect(refreshDocSource("gone")).rejects.toThrow(/unknown source 'gone'/);
  });

  it("lets the same name be added again right after a rollback", async () => {
    dropSourceState("again");
    mocks.parseLlmsTxt.mockRejectedValueOnce(new Error("HTTP 503"));
    await expect(addDocSource("again", "https://docs.example.com/llms.txt")).rejects.toThrow(/HTTP 503/);

    mocks.parseLlmsTxt.mockResolvedValueOnce([["A", "https://docs.example.com/a.md"]]);
    const res = await addDocSource("again", "https://docs.example.com/llms.txt");
    expect(res.docCount).toBe(1);
  });

  it("reports the unique document count", async () => {
    dropSourceState("ok");
    mocks.parseLlmsTxt.mockResolvedValueOnce([
      ["A", "https://docs.example.com/a.md"],
      ["B", "https://docs.example.com/b.md"],
    ]);
    const res = await addDocSource("ok", "https://docs.example.com/llms.txt");
    expect(res.docCount).toBe(2);
    expect(getSource("ok")).toBeDefined();
  });
});

describe("fetchDoc source authorization", () => {
  const HERDR = "https://herdr.dev/llms.txt";
  const RAW = "https://raw.githubusercontent.com/ogulcancelik/herdr/main/docs/panes.md";

  /** parseLlmsTxt stub: listed llms.txt files resolve, every other source fails to index. */
  function stubIndexes(lists: Record<string, [string, string][]>) {
    mocks.parseLlmsTxt.mockImplementation(async (url: string) => {
      const links = lists[url];
      if (!links) throw new Error(`unreachable: ${url}`);
      return links;
    });
  }

  beforeEach(() => {
    mocks.fetchAndClean.mockImplementation(async (url: string) => ({
      url,
      title: "panes.md",
      content: `body of ${url}`,
    }));
  });

  it("fetches an off-host URL listed by an indexed source", async () => {
    stubIndexes({ [HERDR]: [["Panes", RAW]] });
    await addDocSource("herdr", HERDR);

    const res = await fetchDoc(RAW);
    expect(res.error).toBeUndefined();
    expect(res.source).toBe("herdr");
    expect(res.content).toBe(`body of ${RAW}`);
  });

  it("indexes unindexed sources on demand and skips those that fail to index", async () => {
    stubIndexes({ [HERDR]: [["Panes", RAW]] });
    addSourceEntry("herdr", HERDR);

    const res = await fetchDoc(RAW);
    expect(res.source).toBe("herdr");
    expect(res.content).toBe(`body of ${RAW}`);
    expect(mocks.parseLlmsTxt).toHaveBeenCalledWith(HERDR);
  });

  it("matches a listed URL after normalizing it", async () => {
    stubIndexes({ [HERDR]: [["Panes", RAW]] });
    await addDocSource("herdr", HERDR);

    const res = await fetchDoc(RAW.replace("raw.githubusercontent.com", "RAW.GitHubUserContent.com"));
    expect(res.source).toBe("herdr");
    expect(mocks.fetchAndClean).toHaveBeenCalledWith(RAW);
  });

  it("rejects an off-host URL that no source lists, without fetching it", async () => {
    stubIndexes({ [HERDR]: [["Panes", RAW]] });
    await addDocSource("herdr", HERDR);

    const res = await fetchDoc("https://raw.githubusercontent.com/someone/else/main/secrets.md");
    expect(res.error).toMatch(/not under or listed by any registered source/);
    expect(mocks.fetchAndClean).not.toHaveBeenCalled();
  });

  it("rejects an unparseable URL", async () => {
    const res = await fetchDoc("not a url");
    expect(res.error).toMatch(/not under or listed by any registered source/);
    expect(mocks.fetchAndClean).not.toHaveBeenCalled();
  });

  it("prefers the source whose index already has the page cached", async () => {
    const A = "https://a.example.com/llms.txt";
    const B = "https://b.example.com/llms.txt";
    stubIndexes({ [A]: [["Panes", RAW]], [B]: [["Panes", RAW]] });
    await addDocSource("a", A);
    await addDocSource("b", B);
    const stB = await ensureSourceIndexed(getSource("b")!);
    await ensurePage(stB, RAW);
    expect(mocks.fetchAndClean).toHaveBeenCalledTimes(1);

    const res = await fetchDoc(RAW);
    expect(res.source).toBe("b");
    expect(mocks.fetchAndClean).toHaveBeenCalledTimes(1);
  });

  it("uses the source that lists a URL over another whose prefix covers it", async () => {
    const ROOT = "https://docs.example.com/llms.txt";
    const GUIDE = "https://docs.example.com/guide/llms.txt";
    const PAGE = "https://docs.example.com/guide/intro.md";
    stubIndexes({ [ROOT]: [["Home", "https://docs.example.com/index.md"]], [GUIDE]: [["Intro", PAGE]] });
    await addDocSource("root", ROOT);
    await addDocSource("guide", GUIDE);

    const res = await fetchDoc(PAGE);
    expect(res.source).toBe("guide");
  });

  it("uses a covering prefix source before indexing an unindexed source that lists the URL", async () => {
    const ROOT = "https://docs.example.com/llms.txt";
    const MIRROR = "https://mirror.example.com/llms.txt";
    const PAGE = "https://docs.example.com/intro.md";
    stubIndexes({ [ROOT]: [["Home", "https://docs.example.com/index.md"]], [MIRROR]: [["Intro", PAGE]] });
    addSourceEntry("root", ROOT);
    addSourceEntry("mirror", MIRROR);

    const res = await fetchDoc(PAGE);
    expect(res.source).toBe("root");
    expect(mocks.parseLlmsTxt).not.toHaveBeenCalledWith(MIRROR);
  });

  it("fetches a prefix-authorized URL when its source fails to index", async () => {
    const DOCS = "https://docs.example.com/llms.txt";
    const PAGE = "https://docs.example.com/guide/intro.md";
    stubIndexes({});
    addSourceEntry("flaky", DOCS);

    const res = await fetchDoc(PAGE);
    expect(res.error).toBeUndefined();
    expect(res.source).toBe("flaky");
    expect(res.content).toBe(`body of ${PAGE}`);
    expect(mocks.parseLlmsTxt).toHaveBeenCalledWith(DOCS);
  });

  it("returns a non-empty error when the page fetch also fails", async () => {
    const DOCS = "https://docs.example.com/llms.txt";
    stubIndexes({});
    addSourceEntry("flaky", DOCS);
    mocks.fetchAndClean.mockRejectedValueOnce(new Error(""));

    const res = await fetchDoc("https://docs.example.com/guide/intro.md");
    expect(res.source).toBe("flaky");
    expect(res.error).toBe("failed to fetch document");
  });
});

describe("failing sources in search and listing (issues #12, #13)", () => {
  const GOOD = "https://good.example.com/llms.txt";
  const BAD = "https://bad.example.com/llms.txt";

  beforeEach(() => {
    mocks.parseLlmsTxt.mockImplementation(async (url: string) => {
      if (url === GOOD) return [["Agent loop", "https://good.example.com/agent-loop.md"]];
      throw new Error(`HTTP 404 for ${url}`);
    });
    mocks.fetchAndClean.mockImplementation(async (url: string) => ({ url, title: "t", content: "body" }));
    addSourceEntry("good", GOOD);
    addSourceEntry("bad", BAD);
  });

  it("reports a scoped search on a failing source as an error", async () => {
    await expect(searchDocs("agent", "bad", 5)).rejects.toThrow(/source 'bad' failed to index: HTTP 404/);
  });

  it("skips a failing source in unscoped search and does not re-fetch it on the next search", async () => {
    const first = await searchDocs("agent loop", undefined, 5);
    expect(first.results.map((r) => r.source)).toEqual(["good"]);
    await searchDocs("agent loop", undefined, 5);

    const badCalls = mocks.parseLlmsTxt.mock.calls.filter(([u]) => u === BAD);
    expect(badCalls).toHaveLength(1);
  });

  it("surfaces the failure in list_doc_sources", async () => {
    await searchDocs("agent loop", undefined, 5);
    const bad = listDocSources().sources.find((s) => s.name === "bad");
    expect(bad?.indexed).toBe(false);
    expect(bad?.lastError).toBe(`HTTP 404 for ${BAD}`);
    expect(bad?.lastFailedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const good = listDocSources().sources.find((s) => s.name === "good");
    expect(good?.lastError).toBeUndefined();
  });

  it("refresh_doc_source retries a failed source immediately", async () => {
    await expect(searchDocs("agent", "bad", 5)).rejects.toThrow();
    await expect(refreshDocSource("bad")).rejects.toThrow(/HTTP 404/);
    const badCalls = mocks.parseLlmsTxt.mock.calls.filter(([u]) => u === BAD);
    expect(badCalls).toHaveLength(2);
  });

  it("fetch_doc still fetches a prefix-authorized page while its source is in backoff", async () => {
    const PAGE = "https://bad.example.com/guide/intro.md";
    for (let i = 0; i < 2; i++) {
      const res = await fetchDoc(PAGE);
      expect(res.error).toBeUndefined();
      expect(res.source).toBe("bad");
    }
    const badCalls = mocks.parseLlmsTxt.mock.calls.filter(([u]) => u === BAD);
    expect(badCalls).toHaveLength(1);
  });
});

describe("unscoped search merges sources by relevance (issue #11)", () => {
  const SMALL = "https://small.example.com/llms.txt";
  const LARGE = "https://large.example.com/llms.txt";

  beforeEach(() => {
    const large: [string, string][] = Array.from({ length: 400 }, (_, i) => [
      `Topic ${i}`,
      `https://large.example.com/topic-${i}.md`,
    ]);
    large.push(["Sampling rates for telemetry exporters", "https://large.example.com/sampling-rates.md"]);
    const small: [string, string][] = [
      ["Sampling", "https://small.example.com/sampling.md"],
      ["Roots", "https://small.example.com/roots.md"],
      ["Tools", "https://small.example.com/tools.md"],
    ];
    mocks.parseLlmsTxt.mockImplementation(async (url: string) => {
      if (url === SMALL) return small;
      if (url === LARGE) return large;
      throw new Error(`unreachable: ${url}`);
    });
    mocks.fetchAndClean.mockImplementation(async (url: string) => ({ url, title: "t", content: "body" }));
    addSourceEntry("small", SMALL);
    addSourceEntry("large", LARGE);
  });

  it("ranks an exact title match in a small source above a partial match in a large one", async () => {
    const res = await searchDocs("sampling", undefined, 2);
    expect(res.results.map((r) => r.url)).toEqual([
      "https://small.example.com/sampling.md",
      "https://large.example.com/sampling-rates.md",
    ]);
  });

  it("reports scores between 0 and 1", async () => {
    const res = await searchDocs("sampling", undefined, 2);
    for (const r of res.results) {
      expect(r.score).toBeGreaterThan(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }
  });

  it("keeps a scoped search in the same order as before", async () => {
    const scoped = await searchDocs("topic sampling", "large", 3);
    const st = await ensureSourceIndexed(getSource("large")!);
    expect(scoped.results.map((r) => r.url)).toEqual(
      st.index.search("topic sampling", 3).map((h) => h.doc.uri)
    );
  });
});

describe("fetch_doc with a #fragment (issue #17)", () => {
  const DOCS = "https://docs.example.com/llms.txt";
  const PAGE = "https://docs.example.com/prompt-caching.md";

  beforeEach(() => {
    mocks.parseLlmsTxt.mockImplementation(async (url: string) => {
      if (url === DOCS) return [["Prompt caching", PAGE]];
      throw new Error(`unreachable: ${url}`);
    });
    mocks.fetchAndClean.mockImplementation(async (url: string) => ({
      url,
      title: url.split("/").pop(),
      content: "body",
    }));
  });

  it("returns the curated title and fetches the page without the fragment", async () => {
    await addDocSource("docs", DOCS);
    const res = await fetchDoc(`${PAGE}#supported-models`);
    expect(res.error).toBeUndefined();
    expect(res.title).toBe("Prompt caching");
    expect(res.url).toBe(PAGE);
    expect(mocks.fetchAndClean).toHaveBeenCalledWith(PAGE);
  });

  it("fetches a page once for any number of distinct fragments", async () => {
    await addDocSource("docs", DOCS);
    await fetchDoc(`${PAGE}#a`);
    await fetchDoc(`${PAGE}#b`);
    await fetchDoc(PAGE);
    expect(mocks.fetchAndClean).toHaveBeenCalledTimes(1);
  });

  it("authorizes an unlisted URL under the source's directory reached via a fragment", async () => {
    await addDocSource("docs", DOCS);
    const UNLISTED = "https://docs.example.com/guide/intro.md";
    const res = await fetchDoc(`${UNLISTED}#install`);
    expect(res.error).toBeUndefined();
    expect(res.source).toBe("docs");
    expect(res.url).toBe(UNLISTED);
    expect(mocks.fetchAndClean).toHaveBeenCalledWith(UNLISTED);
  });

  it("authorizes a listed off-host URL reached via a fragment", async () => {
    const RAW = "https://raw.githubusercontent.com/o/r/main/docs/panes.md";
    mocks.parseLlmsTxt.mockImplementation(async (url: string) => {
      if (url === DOCS) return [["Panes", RAW]];
      throw new Error(`unreachable: ${url}`);
    });
    await addDocSource("docs", DOCS);
    const res = await fetchDoc(`${RAW}#layout`);
    expect(res.source).toBe("docs");
    expect(res.title).toBe("Panes");
  });
});
