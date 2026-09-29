import { describe, it, expect } from "vitest";
import { extractLlmsTxtLinks } from "../src/utils/doc-fetcher.js";

const BASE = "https://docs.example.com/llms.txt";

describe("extractLlmsTxtLinks", () => {
  it("resolves relative links against the llms.txt url", () => {
    const links = extractLlmsTxtLinks("- [Getting Started](/guide.md)\n- [Why](guide/why.md)", BASE);
    expect(links).toEqual([
      ["Getting Started", "https://docs.example.com/guide.md"],
      ["Why", "https://docs.example.com/guide/why.md"],
    ]);
  });

  it("keeps one entry per URL; later distinct titles go to otherTitles", () => {
    const txt = [
      "- [Pause for input and control](https://docs.example.com/hitl/index.md)",
      "- [Manage the context window](/context/index.md)",
      "- [Human in the loop](https://docs.example.com/hitl/index.md)",
      "- [Overview](https://docs.example.com/context/index.md)",
      "- [Overview](https://docs.example.com/context/index.md)",
    ].join("\n");
    expect(extractLlmsTxtLinks(txt, BASE)).toEqual([
      ["Pause for input and control", "https://docs.example.com/hitl/index.md", ["Human in the loop"]],
      ["Manage the context window", "https://docs.example.com/context/index.md", ["Overview"]],
    ]);
  });

  it("does not record a repeated identical title as an alternate", () => {
    const txt = "[Hooks](/hooks.md)\n[Hooks](/hooks.md)";
    expect(extractLlmsTxtLinks(txt, BASE)).toEqual([["Hooks", "https://docs.example.com/hooks.md", []]]);
  });

  it("skips non-http(s) links", () => {
    const links = extractLlmsTxtLinks("[Mail](mailto:a@example.com) [Doc](/a.md)", BASE);
    expect(links).toEqual([["Doc", "https://docs.example.com/a.md"]]);
  });

  it("throws when an HTML page yields no links, and says so", () => {
    const html = "<!doctype html>\n<html><head><title>Landing</title></head><body>Hi</body></html>";
    expect(() => extractLlmsTxtLinks(html, BASE)).toThrow(/no markdown links.*HTML page/);
  });

  it("throws on an empty or link-free llms.txt", () => {
    expect(() => extractLlmsTxtLinks("# Title\n\nNo links here.", BASE)).toThrow(/no markdown links/);
    expect(() => extractLlmsTxtLinks("", BASE)).toThrow(/no markdown links/);
  });
});
