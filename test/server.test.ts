import { describe, it, expect, beforeEach } from "vitest";
import {
  deriveBase,
  findSourceForUrl,
  addSourceEntry,
  removeSourceEntry,
  getSources,
  _resetRegistryCache,
} from "../src/utils/registry.js";
import { assertPublicHttpUrl, isPublicAddress, URLValidationError } from "../src/utils/url-validator.js";
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

  it("does not authorize a same-prefix host on a different origin", () => {
    addSourceEntry("lg", "https://langchain-ai.github.io/langgraph/llms.txt");
    // Different host that merely starts with the same string must not match.
    expect(findSourceForUrl("https://langchain-ai.github.io.evil.com/langgraph/x.md")).toBeUndefined();
    // Path-prefix must respect the / boundary: /langgraph must not authorize /langgraph-evil.
    expect(findSourceForUrl("https://langchain-ai.github.io/langgraph-evil/x.md")).toBeUndefined();
    expect(findSourceForUrl("https://langchain-ai.github.io/langgraph/x.md")?.name).toBe("lg");
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
  it("rejects encoded / alternate-form private IP literals", () => {
    // Decimal, octal, and hex encodings of 127.0.0.1 and metadata IP.
    expect(() => assertPublicHttpUrl("http://2130706433/x")).toThrow(URLValidationError); // 127.0.0.1
    expect(() => assertPublicHttpUrl("http://0x7f000001/x")).toThrow(URLValidationError); // 127.0.0.1
    // Cloud metadata endpoint and its IPv4-mapped IPv6 form.
    expect(() => assertPublicHttpUrl("http://169.254.169.254/latest/meta-data/")).toThrow(URLValidationError);
    expect(() => assertPublicHttpUrl("http://[::ffff:169.254.169.254]/x")).toThrow(URLValidationError);
    // IPv6 loopback and unique-local.
    expect(() => assertPublicHttpUrl("http://[::1]/x")).toThrow(URLValidationError);
    expect(() => assertPublicHttpUrl("http://[fd00::1]/x")).toThrow(URLValidationError);
    // Carrier-grade NAT range.
    expect(() => assertPublicHttpUrl("http://100.64.0.1/x")).toThrow(URLValidationError);
  });
});

describe("isPublicAddress", () => {
  it("accepts routable public addresses", () => {
    expect(isPublicAddress("8.8.8.8")).toBe(true);
    expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
  });
  it("rejects private, loopback, link-local, and metadata addresses", () => {
    for (const ip of [
      "127.0.0.1",
      "10.0.0.5",
      "192.168.1.1",
      "172.16.0.1",
      "169.254.169.254",
      "100.64.0.1",
      "::1",
      "fd00::1",
      "fe80::1",
      "::ffff:127.0.0.1",
    ]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
  });
  it("rejects garbage input", () => {
    expect(isPublicAddress("not-an-ip")).toBe(false);
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
