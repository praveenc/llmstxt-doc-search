import { describe, it, expect } from "vitest";
import { looksLikeHtml } from "../src/utils/doc-fetcher.js";

describe("looksLikeHtml", () => {
  it("detects an HTML document", () => {
    const html = "<!doctype html>\n<html><head><title>x</title></head><body>hi</body></html>";
    expect(looksLikeHtml(html)).toBe(true);
  });

  it("detects uppercase <HTML>/<BODY>", () => {
    expect(looksLikeHtml("<HTML><BODY>Hi</BODY></HTML>")).toBe(true);
  });

  it("detects a marker within the sniff prefix", () => {
    expect(looksLikeHtml("<body>content")).toBe(true);
    expect(looksLikeHtml("<head>")).toBe(true);
    expect(looksLikeHtml("  \n<html lang=\"en\">")).toBe(true);
  });

  it("treats a markdown doc whose only <body> is past the 8KB prefix as markdown", () => {
    const md = "# Heading\n\n" + "filler ".repeat(2000) + "\n<body>late marker</body>";
    expect(md.length).toBeGreaterThan(8192);
    expect(looksLikeHtml(md)).toBe(false);
  });

  it("detects an HTML marker that sits just inside the 8KB prefix", () => {
    const withinPrefix = "x".repeat(8000) + "<html>";
    expect(withinPrefix.length).toBeLessThan(8192);
    expect(looksLikeHtml(withinPrefix)).toBe(true);
  });

  it("returns false for plain markdown with no html markers", () => {
    const md = "# Title\n\nSome **markdown** text with a [link](https://example.com) and `code`.";
    expect(looksLikeHtml(md)).toBe(false);
  });
});
