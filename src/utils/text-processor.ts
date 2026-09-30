/**
 * Text processing utilities for snippets and title normalization.
 */

/** Regex to collapse whitespace */
const WHITESPACE_RE = /\s+/g;

/** Regex to match code fences */
const CODE_FENCE_RE = /```[\s\S]*?```/g;

/** Leading YAML frontmatter block (`---` ... `---`). */
const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;

/** Empty named anchors such as `<a name="x"></a>` that AWS markdown embeds. */
const EMPTY_ANCHOR_RE = /<a\s+(?:name|id)=["'][^"']*["']\s*>\s*<\/a>/gi;

const LIST_ITEM_RE = /^(?:[-*+]\s|\d+[.)]\s)/;
const HORIZONTAL_RULE_RE = /^(?:[-*_]\s*){3,}$/;
const TAG_ONLY_LINE_RE = /^(?:<[^>]*>\s*)+$/;

/** A line wrapped entirely in one emphasis span, e.g. `*[Watch on YouTube](...)*`. */
const EMPHASIS_ONLY_LINE_RE = /^(?:\*{1,3}[^*\s][^*]*\*{1,3}|_{1,3}[^_\s][^_]*_{1,3})$/;
/** A line that is only a link or image, e.g. `[Watch on YouTube](...)`. */
const LINK_ONLY_LINE_RE = /^!?\[[^\]]*\]\([^)]*\)$/;

/** Opening line of a `:::` container (VitePress, Docusaurus), e.g. `::: warning`. */
const CONTAINER_OPEN_RE = /^:{3,}\s*\S/;
/** Closing line of a `:::` container. */
const CONTAINER_CLOSE_RE = /^:{3,}$/;

/**
 * Lines that are structure rather than prose: headings, quotes, lists, rules,
 * bare tags, and lines wrapped entirely in emphasis (a `**Note**` label or a
 * `*[Watch on YouTube](...)*` banner). `:::` containers are removed
 * beforehand by dropContainers.
 */
function isNonProseLine(line: string): boolean {
  return (
    line.startsWith("#") ||
    line.startsWith(">") ||
    LIST_ITEM_RE.test(line) ||
    HORIZONTAL_RULE_RE.test(line) ||
    TAG_ONLY_LINE_RE.test(line) ||
    EMPHASIS_ONLY_LINE_RE.test(line)
  );
}

/**
 * Remove `:::` containers (admonitions, details blocks) together with their
 * contents. Nested containers are tracked by depth; an unclosed container
 * runs to the end, as markdown-it-container treats it.
 */
function dropContainers(lines: string[]): string[] {
  const out: string[] = [];
  let depth = 0;
  for (const line of lines) {
    if (CONTAINER_OPEN_RE.test(line)) {
      depth++;
    } else if (CONTAINER_CLOSE_RE.test(line)) {
      if (depth > 0) depth--;
    } else if (depth === 0) {
      out.push(line);
    }
  }
  return out;
}

/**
 * Normalize whitespace in a string.
 */
export function normalize(s: string): string {
  return s.replace(WHITESPACE_RE, " ").trim();
}

/**
 * A URL without its `#fragment`. A fragment names a place within a page, not
 * a different page, so it is dropped before a URL is used as a lookup,
 * cache or fetch key.
 */
export function stripFragment(url: string): string {
  const i = url.indexOf("#");
  return i >= 0 ? url.slice(0, i) : url;
}

/** A document file extension at the end of a URL slug or file name. */
const DOC_EXTENSION_RE = /\.(?:md|mdx|markdown|html?|txt)$/i;

/**
 * Generate a human-readable title from a URL path.
 */
export function titleFromUrl(url: string): string {
  const noQuery = stripFragment(url).split("?")[0];
  const path = noQuery.includes("://") ? noQuery.split("://")[1] : noQuery;
  const parts = path.split("/").filter(Boolean);

  // Remove trailing index.*
  if (parts.length > 0 && parts[parts.length - 1].startsWith("index.")) {
    parts.pop();
  }

  // Drop the file extension so it does not become a title word (and a search
  // term shared by every page on a .md site).
  const slug = (parts[parts.length - 1] || path).replace(DOC_EXTENSION_RE, "");
  const title = slug.replace(/[-_]/g, " ").trim();

  // Title case
  return title
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ") || "Documentation";
}

/**
 * Determine the best display title for a document.
 *
 * Priority:
 * 1. Curated title from llms.txt (highest)
 * 2. URL-derived title if extracted is missing/generic
 * 3. Normalized extracted title
 */
export function formatDisplayTitle(
  url: string,
  extracted: string | null,
  urlTitles: Map<string, string>
): string {
  // Check curated first
  const curated = urlTitles.get(url);
  if (curated) return normalize(curated);

  // No extracted title or generic - use URL slug
  if (!extracted) return titleFromUrl(url);

  const t = extracted.trim();
  // A bare file name (e.g. "page.md", "page.html") is not a real title.
  if (!t || t.toLowerCase() === "index" || (DOC_EXTENSION_RE.test(t) && !/\s/.test(t))) {
    return titleFromUrl(url);
  }

  return normalize(t);
}

/**
 * Generate searchable title variants for indexing.
 */
export function indexTitleVariants(displayTitle: string, url: string): string {
  const base = displayTitle;
  const slug = titleFromUrl(url);

  // Numeric-to-word variant: '2' -> 'to' (e.g., Agent2Agent)
  const variant = base.replace(/(\w)2(\w)/gi, "$1 to $2");

  // Build distinct set
  const variants: string[] = [];
  for (const v of [base, variant, slug]) {
    const normalized = normalize(v);
    if (normalized && !variants.some((x) => x.toLowerCase() === normalized.toLowerCase())) {
      variants.push(normalized);
    }
  }

  return variants.join(" ");
}

/**
 * Normalize string for case-insensitive comparison.
 */
function normalizeForComparison(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(WHITESPACE_RE, " ").trim();
}

/**
 * Create a contextual snippet from page content.
 *
 * Skips leading YAML frontmatter, blockquotes (e.g. site-wide "documentation
 * index" banners), `:::` containers and their contents, headings, list items,
 * horizontal rules, tag-only HTML lines, emphasis-only lines and leading
 * link-only lines, then returns the first prose paragraph.
 */
export function makeSnippet(
  content: string | null,
  displayTitle: string,
  maxChars: number = 300
): string {
  if (!content) return displayTitle;

  let text = content.trim().replace(FRONTMATTER_RE, "");
  text = text.replace(CODE_FENCE_RE, "");
  text = text.replace(EMPTY_ANCHOR_RE, "");

  const lines = dropContainers(text.split("\n").map((l) => l.trim()).filter(Boolean));

  // Drop first line if it looks like a title or heading
  if (lines.length > 0) {
    const first = lines[0];
    if (
      first.startsWith("#") ||
      normalizeForComparison(first) === normalizeForComparison(displayTitle) ||
      normalizeForComparison(first).startsWith(normalizeForComparison(displayTitle))
    ) {
      lines.shift();
    }
  }

  const buf: string[] = [];
  for (const line of lines) {
    if (isNonProseLine(line)) {
      if (buf.length > 0) break;
      continue;
    }
    // A bare link before any prose is navigation; inside a paragraph it is
    // usually hard-wrapped prose, so it is kept.
    if (buf.length === 0 && LINK_ONLY_LINE_RE.test(line)) continue;
    buf.push(line);
    // Stop when we have a decent paragraph
    if (buf.join(" ").length >= 120 || line.endsWith(".")) {
      break;
    }
  }

  let snippet = buf.length > 0 ? buf.join(" ") : displayTitle;
  snippet = snippet.replace(WHITESPACE_RE, " ").trim();

  if (snippet.length > maxChars) {
    snippet = snippet.slice(0, maxChars - 1).trimEnd() + "…";
  }

  return snippet;
}
