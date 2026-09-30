import { describe, it, expect } from "vitest";
import { cleanMarkdown, htmlToText, looksLikeHtml } from "../src/utils/doc-fetcher.js";

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

describe("htmlToText", () => {
  const page = (body: string) =>
    `<!doctype html><html><head><title>T</title><style>.x{}</style></head><body>${body}</body></html>`;

  it("keeps only <main> content when the page has one", () => {
    const html = page(
      `<header><a href="/">Site</a> Docs Blog</header>` +
        `<nav>Sidebar link</nav>` +
        `<main><header><h1>Page heading</h1></header><p>Body text.</p>` +
        `<aside>On this page</aside><footer>Prev Next</footer></main>` +
        `<footer>Copyright</footer>`,
    );
    const text = htmlToText(html);
    expect(text).toContain("Page heading");
    expect(text).toContain("Body text.");
    for (const chrome of ["Site", "Sidebar link", "On this page", "Prev Next", "Copyright"]) {
      expect(text).not.toContain(chrome);
    }
  });

  it("strips nav, aside, footer and header when there is no <main>", () => {
    const html = page(
      `<header>Top bar</header><nav>Menu</nav><div><p>Content</p></div><footer>Foot</footer>`,
    );
    expect(htmlToText(html)).toBe("Content");
  });

  it("removes nested chrome elements completely", () => {
    const html = page(`<nav>Outer <nav>Inner</nav> tail</nav><p>Kept</p>`);
    expect(htmlToText(html)).toBe("Kept");
  });

  it("falls back to the whole page when <main> has no text", () => {
    const html = page(`<main></main><div>Real content</div><nav>Menu</nav>`);
    expect(htmlToText(html)).toBe("Real content");
  });

  it("does not treat <head>, <mainframe> or custom elements as chrome", () => {
    const html = page(`<nav-card>Card text</nav-card><p>Para</p>`);
    const text = htmlToText(html);
    expect(text).toContain("Card text");
    expect(text).toContain("Para");
  });

  it("drops <head> text such as the <title>", () => {
    expect(htmlToText(page(`<header>Bar</header><p>Only</p>`))).toBe("Only");
  });

  it("collapses runs of spaces within a line", () => {
    const html = page(`<p>a    b&nbsp;&nbsp; c</p>\n<p>  d  </p>`);
    expect(htmlToText(html)).toBe("a b c\nd");
  });

  it("stays fast on unclosed chrome tags", () => {
    const html = page("<nav>x ".repeat(200_000) + "<p>end</p>");
    const start = performance.now();
    const text = htmlToText(html);
    expect(performance.now() - start).toBeLessThan(2000);
    expect(text).toContain("end");
  });
});

describe("cleanMarkdown", () => {
  it("removes empty name/id anchors and keeps real links", () => {
    const md =
      '<a name="overview"></a>\n## Overview\n' +
      "Text <a id='x'> </a>here.\n" +
      '<a href="https://example.com">link</a> and <a name="kept">label</a>';
    expect(cleanMarkdown(md)).toBe(
      '\n## Overview\nText here.\n<a href="https://example.com">link</a> and <a name="kept">label</a>',
    );
  });
});
