import { describe, it, expect } from "vitest";
import {
  makeSnippet,
  stripFragment,
  titleFromUrl,
  formatDisplayTitle,
  indexTitleVariants,
} from "../src/utils/text-processor.js";
import { tokenize, IndexSearch } from "../src/utils/indexer.js";

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

  it("skips VitePress ::: containers and the text inside them (issue #34)", () => {
    const md = [
      "---",
      "url: /guide/github-actions-cache.md",
      "---",
      "# GitHub Actions Cache",
      "",
      "::: warning Experimental",
      "Reusing Vite Task's cache across GitHub Actions runs is experimental.",
      ":::",
      "",
      "Vite Task stores task results in `node_modules/.vite/task-cache` at the workspace root.",
    ].join("\n");
    expect(makeSnippet(md, "GitHub Actions Cache")).toBe(
      "Vite Task stores task results in `node_modules/.vite/task-cache` at the workspace root."
    );
  });

  it("skips nested ::: containers", () => {
    const md = [
      "::: details Outer",
      "Outer text.",
      "::: tip Inner",
      "Inner text.",
      ":::",
      "Still outer.",
      ":::",
      "After the containers.",
    ].join("\n");
    expect(makeSnippet(md, "X")).toBe("After the containers.");
  });

  it("treats an unclosed ::: container as running to the end", () => {
    const md = ["Intro.", "::: warning", "Never closed."].join("\n");
    expect(makeSnippet(md, "X")).toBe("Intro.");
    expect(makeSnippet(["::: warning", "Never closed."].join("\n"), "Fallback")).toBe("Fallback");
  });

  it("ignores a stray closing ::: line", () => {
    expect(makeSnippet([":::", "Prose after a stray fence."].join("\n"), "X")).toBe("Prose after a stray fence.");
  });

  it("skips a line that is only an emphasized link (issue #33, Strands lessons)", () => {
    const md = [
      "*[Watch on YouTube](https://www.youtube.com/watch?v=ZpXWGjISMs8&list=PLDzwjhH-4yhU)*",
      "",
      "About this lesson",
      "",
      "The videos in this course are a snapshot in time. Strands is under active development.",
      "",
      "*Code for this lesson: [`samples/01-agent-loop`](https://github.com/aws-samples/x)*",
    ].join("\n");
    expect(makeSnippet(md, "Lesson 1: How Agents Really Work")).toBe(
      "About this lesson The videos in this course are a snapshot in time. Strands is under active development."
    );
  });

  it("skips lines that are only emphasis, a link or an image", () => {
    const md = [
      "_Last updated: 2026-09-01_",
      "**Note**",
      "[Back to index](../index.md)",
      "![diagram](arch.png)",
      "Real prose here.",
    ].join("\n");
    expect(makeSnippet(md, "X")).toBe("Real prose here.");
  });

  it("keeps prose that starts or ends with emphasis", () => {
    expect(makeSnippet("*Agents* wrap a model in a runtime loop.", "X")).toBe(
      "*Agents* wrap a model in a runtime loop."
    );
    expect(makeSnippet("Tools run inside the *agent loop*", "X")).toBe("Tools run inside the *agent loop*");
    expect(makeSnippet("See [the guide](g.md) for setup.", "X")).toBe("See [the guide](g.md) for setup.");
    expect(makeSnippet("**Step one** then **step two**", "X")).toBe("**Step one** then **step two**");
    expect(makeSnippet("_snake_case_ names are kept.", "X")).toBe("_snake_case_ names are kept.");
    expect(makeSnippet("**Note:** agents need a model.", "X")).toBe("**Note:** agents need a model.");
  });

  it("keeps a link-only line inside a hard-wrapped paragraph (MCP)", () => {
    const md = [
      "This document provides security considerations for the Model Context",
      "Protocol (MCP), complementing the",
      "[MCP Authorization](/specification/2025-03-26/basic/authorization)",
      "specification.",
    ].join("\n");
    expect(makeSnippet(md, "Security Best Practices")).toBe(
      "This document provides security considerations for the Model Context Protocol (MCP), " +
        "complementing the [MCP Authorization](/specification/2025-03-26/basic/authorization)"
    );
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

describe("URLs with #fragments (issue #17)", () => {
  it("stripFragment drops the fragment and keeps the rest", () => {
    expect(stripFragment("https://docs.example.com/a.md#supported-models")).toBe("https://docs.example.com/a.md");
    expect(stripFragment("https://docs.example.com/a.md?v=2#x")).toBe("https://docs.example.com/a.md?v=2");
    expect(stripFragment("https://docs.example.com/a.md#")).toBe("https://docs.example.com/a.md");
    expect(stripFragment("https://docs.example.com/a.md")).toBe("https://docs.example.com/a.md");
  });

  it("titleFromUrl ignores the fragment and query string", () => {
    expect(titleFromUrl("https://docs.example.com/prompt-caching#supported-models")).toBe("Prompt Caching");
    expect(titleFromUrl("https://docs.example.com/prompt-caching?lang=en")).toBe("Prompt Caching");
  });

  it("formatDisplayTitle uses the curated title when the page was reached via a fragment", () => {
    const titles = new Map([["https://docs.example.com/prompt-caching.md", "Prompt caching"]]);
    expect(
      formatDisplayTitle(stripFragment("https://docs.example.com/prompt-caching.md#supported-models"), "prompt-caching.md", titles)
    ).toBe("Prompt caching");
  });
});

describe("title weight does not depend on the URL slug (issue #32)", () => {
  const BASE = "https://docs.aws.amazon.com/bedrock/latest/userguide/";

  it("indexes the title once, adding only slug words it lacks", () => {
    expect(indexTitleVariants("Prompt caching", `${BASE}prompt-caching.md`)).toBe("Prompt caching");
    expect(indexTitleVariants("What is prompt engineering?", `${BASE}what-is-prompt-engineering.md`)).toBe(
      "What is prompt engineering?"
    );
    expect(indexTitleVariants("Evaluator prompts", `${BASE}kb-eval-prompt.md`)).toBe("Evaluator prompts kb eval");
  });

  it("treats a slug word as repeated when it stems to a title word", () => {
    expect(indexTitleVariants("Design a flow", `${BASE}flows-design.md`)).toBe("Design a flow");
    expect(indexTitleVariants("Evaluate models", `${BASE}evaluation.md`)).toBe("Evaluate models");
  });

  it("keeps new words from the 2 -> to variant", () => {
    expect(indexTitleVariants("Agent2Agent protocol", `${BASE}a2a.md`)).toBe("Agent2Agent protocol agent a2a");
  });

  it("scores titles alike whether the slug matches them exactly or only up to punctuation", () => {
    const index = new IndexSearch();
    for (const [title, slug] of [
      ["Prompt caching", "prompt-caching"],
      ["Prompt caching!", "prompt-caching"],
      ["What is prompt caching?", "what-is-prompt-caching"],
      ["What is prompt caching", "what-is-prompt-caching"],
    ]) {
      const uri = `${BASE}${slug}-${title.length}.md`;
      index.add({ uri, displayTitle: title, content: "", indexTitle: indexTitleVariants(title, `${BASE}${slug}.md`) });
    }
    const scoreOf = new Map(index.search("prompt caching", 10).map((r) => [r.doc.displayTitle, r.score]));
    expect(scoreOf.get("Prompt caching!")).toBeCloseTo(scoreOf.get("Prompt caching")!, 10);
    expect(scoreOf.get("What is prompt caching?")).toBeCloseTo(scoreOf.get("What is prompt caching")!, 10);
  });
});

describe("file extensions in URL-derived titles (issue #18)", () => {
  it("titleFromUrl drops a document extension from the slug", () => {
    expect(titleFromUrl("https://viteplus.dev/guide/global-cli.md")).toBe("Global Cli");
    expect(titleFromUrl("https://docs.example.com/guide/intro.mdx")).toBe("Intro");
    expect(titleFromUrl("https://docs.example.com/guide/intro.HTML")).toBe("Intro");
    expect(titleFromUrl("https://docs.example.com/guide/intro.htm")).toBe("Intro");
    expect(titleFromUrl("https://docs.example.com/guide/intro.md#setup")).toBe("Intro");
  });

  it("keeps dots that are not a document extension", () => {
    expect(titleFromUrl("https://strandsagents.com/api/strands.event_loop.md")).toBe("Strands.event Loop");
    expect(titleFromUrl("https://docs.example.com/v1.2/notes")).toBe("Notes");
  });

  it("index titles no longer carry an md token", () => {
    const variants = indexTitleVariants("Global CLI", "https://viteplus.dev/guide/global-cli.md");
    expect(variants).toBe("Global CLI");
    expect(tokenize(variants)).not.toContain("md");
  });

  it("formatDisplayTitle treats a bare file name as no title", () => {
    const none = new Map<string, string>();
    expect(formatDisplayTitle("https://docs.example.com/guide/intro.md", "intro.md", none)).toBe("Intro");
    expect(formatDisplayTitle("https://docs.example.com/guide/intro.html", "intro.html", none)).toBe("Intro");
    expect(formatDisplayTitle("https://docs.example.com/readme", "Editing README.md", none)).toBe("Editing README.md");
  });
});
