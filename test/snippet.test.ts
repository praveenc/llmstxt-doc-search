import { describe, it, expect } from "vitest";
import { makeSnippet } from "../src/utils/text-processor.js";

describe("makeSnippet", () => {
  it("skips a leading documentation-index blockquote banner (Mintlify)", () => {
    const md = [
      "> ## Documentation Index",
      "> Fetch the complete documentation index at: https://modelcontextprotocol.io/llms.txt",
      "> Use this file to discover all available pages before exploring further.",
      "",
      "# Streamable HTTP",
      "",
      '<div id="enable-section-numbers" />',
      "",
      "<Info>",
      "  Streamable HTTP was introduced in protocol version 2025-03-26 as a replacement",
      "  for the HTTP+SSE transport from protocol version 2024-11-05.",
      "</Info>",
    ].join("\n");
    expect(makeSnippet(md, "Streamable HTTP")).toBe(
      "Streamable HTTP was introduced in protocol version 2025-03-26 as a replacement " +
        "for the HTTP+SSE transport from protocol version 2024-11-05."
    );
  });

  it("skips YAML frontmatter (VitePress)", () => {
    const md = [
      "---",
      "url: /guide/cache.md",
      "---",
      "# Task Caching",
      "",
      "Vite Task can automatically track dependencies and cache tasks run through `vp run`.",
    ].join("\n");
    expect(makeSnippet(md, "Task Caching")).toBe(
      "Vite Task can automatically track dependencies and cache tasks run through `vp run`."
    );
  });

  it("drops empty named anchors and keeps a paragraph that opens with bold text (AWS)", () => {
    const md = [
      "",
      "# Increase model invocation capacity with Provisioned Throughput in Amazon Bedrock",
      '<a name="prov-throughput"></a>',
      "",
      "**Throughput** refers to the number and rate of inputs and outputs that a model processes and returns.",
    ].join("\n");
    expect(makeSnippet(md, "Provisioned Throughput")).toBe(
      "**Throughput** refers to the number and rate of inputs and outputs that a model processes and returns."
    );
  });

  it("skips VitePress ::: containers", () => {
    const md = [
      "# GitHub Actions Cache",
      "::: warning Experimental",
      "Reusing the cache across runs is experimental.",
      ":::",
    ].join("\n");
    expect(makeSnippet(md, "GitHub Actions Cache")).toBe("Reusing the cache across runs is experimental.");
  });

  it("still skips list items, numbered steps and horizontal rules", () => {
    const md = ["# Title", "- a bullet", "* another", "1. step one", "***", "Real prose here."].join("\n");
    expect(makeSnippet(md, "Title")).toBe("Real prose here.");
  });

  it("stops at the first structural line after prose", () => {
    const md = ["Intro line one", "> a later quote", "More text."].join("\n");
    expect(makeSnippet(md, "Other")).toBe("Intro line one");
  });

  it("does not treat an inline --- in prose as frontmatter", () => {
    const md = "Plain text --- with dashes.\n\nNext.";
    expect(makeSnippet(md, "X")).toBe("Plain text --- with dashes.");
  });

  it("falls back to the title when nothing is prose", () => {
    expect(makeSnippet("> only a quote\n- only a list", "Fallback")).toBe("Fallback");
    expect(makeSnippet(null, "Fallback")).toBe("Fallback");
  });
});
