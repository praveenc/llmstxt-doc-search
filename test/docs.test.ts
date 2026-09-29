import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  parseLlmsTxt: vi.fn(),
  fetchAndClean: vi.fn(),
}));

vi.mock("../src/utils/doc-fetcher.js", () => ({
  parseLlmsTxt: mocks.parseLlmsTxt,
  fetchAndClean: mocks.fetchAndClean,
}));

import { addDocSource, topUniqueByUrl } from "../src/tools/docs.js";
import { getSource, _resetRegistryCache } from "../src/utils/registry.js";
import { dropSourceState } from "../src/utils/store.js";
import { existsSync, rmSync } from "node:fs";

const TMP = process.env.LLMSTXT_REGISTRY_PATH || "/tmp/llmstxt-test-sources.json";

beforeEach(() => {
  if (existsSync(TMP)) rmSync(TMP);
  _resetRegistryCache();
  mocks.parseLlmsTxt.mockReset();
  mocks.fetchAndClean.mockReset();
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
