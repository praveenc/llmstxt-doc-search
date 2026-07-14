/**
 * Document fetching and llms.txt parsing.
 */
import { assertPublicHttpUrl } from "./url-validator.js";

const MD_LINK_RE = /\[([^\]]+)\]\(([^)]+)\)/g;
const HTML_BLOCK_RE = /<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi;
const TAG_RE = /<[^>]+>/g;
const TITLE_TAG_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;
const H1_TAG_RE = /<h1[^>]*>([\s\S]*?)<\/h1>/i;
const META_OG_RE = /<meta[^>]+property=["']og:title["'][^>]+content=["']([\s\S]*?)["']/i;

const DEFAULT_TIMEOUT = 30000;
const USER_AGENT = "llmstxt-doc-search/0.1";

export interface Page {
  url: string;
  title: string;
  content: string;
}

async function fetchUrl(url: string): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Parse an llms.txt file into [title, absoluteUrl] tuples.
 * Relative links are resolved against the llms.txt URL; only http(s) links are kept.
 */
export async function parseLlmsTxt(llmsTxtUrl: string): Promise<[string, string][]> {
  const base = assertPublicHttpUrl(llmsTxtUrl);
  const txt = await fetchUrl(base);
  const links: [string, string][] = [];
  let match: RegExpExecArray | null;
  MD_LINK_RE.lastIndex = 0;
  while ((match = MD_LINK_RE.exec(txt)) !== null) {
    const title = (match[1] || "").trim() || (match[2] || "").trim();
    const href = (match[2] || "").trim();
    if (!href) continue;
    try {
      const abs = new URL(href, base).toString();
      if (abs.startsWith("http://") || abs.startsWith("https://")) {
        links.push([title, abs]);
      }
    } catch {
      /* skip unparseable */
    }
  }
  return links;
}

function decodeHtmlEntities(text: string): string {
  const entities: Record<string, string> = {
    "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"',
    "&#39;": "'", "&apos;": "'", "&nbsp;": " ",
  };
  let result = text;
  for (const [entity, char] of Object.entries(entities)) {
    result = result.replaceAll(entity, char);
  }
  result = result.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)));
  result = result.replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)));
  return result;
}

function htmlToText(rawHtml: string): string {
  let stripped = rawHtml.replace(HTML_BLOCK_RE, "");
  stripped = stripped.replace(TAG_RE, " ");
  stripped = decodeHtmlEntities(stripped);
  const lines = stripped.split("\n").map((ln) => ln.trim());
  return lines.filter(Boolean).join("\n");
}

function extractHtmlTitle(rawHtml: string): string | null {
  let match = TITLE_TAG_RE.exec(rawHtml);
  if (match) return decodeHtmlEntities(match[1]).trim();
  match = META_OG_RE.exec(rawHtml);
  if (match) return decodeHtmlEntities(match[1]).trim();
  match = H1_TAG_RE.exec(rawHtml);
  if (match) return decodeHtmlEntities(match[1].replace(TAG_RE, " ")).trim();
  return null;
}

/**
 * Fetch a doc URL and return cleaned content. Handles markdown (plain) and HTML.
 * Caller is responsible for authorizing the URL against the registry.
 */
export async function fetchAndClean(pageUrl: string): Promise<Page> {
  const url = assertPublicHttpUrl(pageUrl);
  const raw = await fetchUrl(url);
  const lower = raw.toLowerCase();
  if (lower.includes("<html") || lower.includes("<head") || lower.includes("<body")) {
    const extractedTitle = extractHtmlTitle(raw);
    const content = htmlToText(raw);
    const title = extractedTitle || url.split("/").pop() || url;
    return { url, title, content };
  }
  const title = url.split("/").pop() || url;
  return { url, title, content: raw };
}
