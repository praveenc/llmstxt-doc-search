import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  parseLlmsTxt: vi.fn(),
  fetchAndClean: vi.fn(),
}));

vi.mock("../src/utils/doc-fetcher.js", () => ({
  parseLlmsTxt: mocks.parseLlmsTxt,
  fetchAndClean: mocks.fetchAndClean,
}));

import { addDocSource, fetchDoc, topUniqueByUrl } from "../src/tools/docs.js";
import { addSourceEntry, getSource, getSources, _resetRegistryCache } from "../src/utils/registry.js";
import { dropSourceState, ensurePage, ensureSourceIndexed } from "../src/utils/store.js";
import { existsSync, rmSync } from "node:fs";

const TMP = process.env.LLMSTXT_REGISTRY_PATH || "/tmp/llmstxt-test-sources.json";

beforeEach(() => {
  if (existsSync(TMP)) rmSync(TMP);
  _resetRegistryCache();
  for (const s of getSources()) dropSourceState(s.name);
  mocks.parseLlmsTxt.mockReset();
  mocks.fetchAndClean.mockReset();
});

afterEach(() => {
  for (const s of getSources()) dropSourceState(s.name);
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
      /failed to index \(rolled back\).*no markdown links/
    );
    expect(getSource("empty")).toBeUndefined();
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
});
