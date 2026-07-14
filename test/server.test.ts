import { describe, it, expect, beforeEach } from "vitest";
import {
  deriveBase,
  findSourceForUrl,
  addSourceEntry,
  removeSourceEntry,
  getSources,
  _resetRegistryCache,
} from "../src/utils/registry.js";
import { assertPublicHttpUrl, URLValidationError } from "../src/utils/url-validator.js";
import { IndexSearch, tokenize } from "../src/utils/indexer.js";
import { existsSync, rmSync } from "node:fs";

const TMP = process.env.LLMSTXT_REGISTRY_PATH || "/tmp/llmstxt-test-sources.json";

beforeEach(() => {
  if (existsSync(TMP)) rmSync(TMP);
  _resetRegistryCache();
});

describe("deriveBase", () => {
  it("strips the llms.txt filename to a directory prefix", () => {
    expect(deriveBase("https://strandsagents.com/llms.txt")).toBe("https://strandsagents.com/");
    expect(deriveBase("https://docs.aws.amazon.com/bedrock/latest/userguide/llms.txt")).toBe(
      "https://docs.aws.amazon.com/bedrock/latest/userguide/"
    );
  });
});

describe("registry", () => {
  it("seeds defaults on first load", () => {
    const names = getSources().map((s) => s.name);
    expect(names).toContain("strands");
    expect(names).toContain("aws-bedrock-userguide");
  });

  it("authorizes a doc url by its source base prefix", () => {
    getSources();
    const src = findSourceForUrl("https://strandsagents.com/docs/user-guide/quickstart/typescript/index.md");
    expect(src?.name).toBe("strands");
    expect(findSourceForUrl("https://evil.example.com/x.md")).toBeUndefined();
  });

  it("adds and removes a source at runtime", () => {
    const added = addSourceEntry("langgraph", "https://langchain-ai.github.io/langgraph/llms.txt");
    expect(added.base).toBe("https://langchain-ai.github.io/langgraph/");
    expect(findSourceForUrl("https://langchain-ai.github.io/langgraph/foo.md")?.name).toBe("langgraph");
    expect(removeSourceEntry("langgraph")).toBe(true);
    expect(removeSourceEntry("langgraph")).toBe(false);
  });

  it("rejects a private/internal llms.txt url", () => {
    expect(() => addSourceEntry("internal", "http://localhost:8080/llms.txt")).toThrow(URLValidationError);
  });

  it("rejects a duplicate source name", () => {
    expect(() => addSourceEntry("strands", "https://strandsagents.com/llms.txt")).toThrow();
  });
});

describe("assertPublicHttpUrl", () => {
  it("accepts public https", () => {
    expect(assertPublicHttpUrl("https://docs.aws.amazon.com/x.md")).toContain("docs.aws.amazon.com");
  });
  it("rejects bad scheme and private hosts", () => {
    expect(() => assertPublicHttpUrl("ftp://x/y")).toThrow(URLValidationError);
    expect(() => assertPublicHttpUrl("http://localhost/x")).toThrow(URLValidationError);
    expect(() => assertPublicHttpUrl("http://10.0.0.5/x")).toThrow(URLValidationError);
    expect(() => assertPublicHttpUrl("not a url")).toThrow(URLValidationError);
  });
});

describe("BM25 index", () => {
  it("ranks the more relevant title higher", () => {
    const ix = new IndexSearch();
    ix.add({ uri: "u1", displayTitle: "Quickstart: TypeScript", content: "", indexTitle: "Quickstart TypeScript" });
    ix.add({ uri: "u2", displayTitle: "Amazon Bedrock model providers", content: "", indexTitle: "Amazon Bedrock model providers" });
    const res = ix.search("typescript quickstart", 5);
    expect(res.length).toBeGreaterThan(0);
    expect(res[0].doc.uri).toBe("u1");
  });
  it("tokenize stems and drops stopwords but preserves domain terms", () => {
    const toks = tokenize("Building agents with Bedrock and streaming");
    expect(toks).toContain("bedrock");
    expect(toks).not.toContain("with");
  });
});
