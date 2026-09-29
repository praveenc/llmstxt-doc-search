/**
 * Document fetching and llms.txt parsing.
 */
import { lookup as dnsLookup } from "node:dns";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import type { IncomingMessage } from "node:http";
import { assertPublicHttpUrl, assertPublicAddress } from "./url-validator.js";

const MD_LINK_RE = /\[([^\]]+)\]\(([^)]+)\)/g;
const HTML_BLOCK_RE = /<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi;
const TAG_RE = /<[^>]+>/g;
const TITLE_TAG_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;
const H1_TAG_RE = /<h1[^>]*>([\s\S]*?)<\/h1>/i;
const META_OG_RE = /<meta[^>]+property=["']og:title["'][^>]+content=["']([\s\S]*?)["']/i;

const DEFAULT_TIMEOUT = 30000;
const USER_AGENT = "llmstxt-doc-search/0.1";
/** Hard cap on a fetched response body to bound memory / ReDoS surface. */
const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB
/** Max number of redirect hops to follow (each re-validated). */
const MAX_REDIRECTS = 5;

/**
 * DNS lookup that rejects any host resolving to a private/reserved address.
 * Enforced at connection time (below), so it also covers DNS rebinding (a
 * public name that resolves to 169.254.169.254, 127.0.0.1, etc.).
 */
const safeLookup: typeof dnsLookup = ((hostname: string, options: any, callback: any) => {
  const cb = typeof options === "function" ? options : callback;
  const opts = typeof options === "function" ? {} : options;
  return dnsLookup(hostname, opts, (err: any, address: any, family: any) => {
    if (err) {
      cb(err, address, family);
      return;
    }
    try {
      if (Array.isArray(address)) {
        for (const a of address) assertPublicAddress(a.address, hostname);
      } else {
        assertPublicAddress(address as string, hostname);
      }
    } catch (e) {
      cb(e, address, family);
      return;
    }
    cb(err, address, family);
  });
}) as typeof dnsLookup;

/** Perform a single (non-redirecting) GET and return the response stream. */
function requestOnce(target: URL, signal: AbortSignal): Promise<IncomingMessage> {
  const request = target.protocol === "http:" ? httpRequest : httpsRequest;
  return new Promise((resolve, reject) => {
    const req = request(
      target,
      {
        method: "GET",
        headers: { "User-Agent": USER_AGENT },
        lookup: safeLookup,
        signal,
      },
      resolve
    );
    req.on("error", reject);
    req.end();
  });
}

export interface Page {
  url: string;
  title: string;
  content: string;
}

async function fetchUrl(url: string): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);
  try {
    // Follow redirects manually so each hop's target is re-validated against
    // the SSRF guard (scheme + literal-IP check) before we connect to it.
    let current = assertPublicHttpUrl(url);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const res = await requestOnce(new URL(current), controller.signal);
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        const loc = res.headers.location;
        res.resume(); // drain the redirect body
        if (!loc) throw new Error(`HTTP ${status}: redirect without Location`);
        if (hop === MAX_REDIRECTS) throw new Error("too many redirects");
        current = assertPublicHttpUrl(new URL(loc, current).toString());
        continue;
      }
      if (status < 200 || status >= 300) {
        res.resume();
        throw new Error(`HTTP ${status}`);
      }
      return await readCapped(res);
    }
    throw new Error("too many redirects");
  } finally {
    clearTimeout(timeoutId);
  }
}

/** Read a response stream as text, aborting past MAX_BODY_BYTES. */
function readCapped(res: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    res.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        res.destroy();
        reject(new Error(`response body exceeds ${MAX_BODY_BYTES} byte cap`));
        return;
      }
      chunks.push(chunk);
    });
    res.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    res.on("error", reject);
  });
}

/**
 * An llms.txt entry: [title, absoluteUrl, otherTitles]. `otherTitles` holds
 * the titles of any later entries for the same URL, so they stay searchable.
 */
export type LlmsTxtLink = [title: string, url: string, otherTitles?: string[]];

/**
 * Parse an llms.txt file into unique links.
 * Relative links are resolved against the llms.txt URL; only http(s) links are kept.
 * Throws if the file yields no links, so an HTML page or empty file is not
 * silently registered as a source with zero documents.
 */
export async function parseLlmsTxt(llmsTxtUrl: string): Promise<LlmsTxtLink[]> {
  const base = assertPublicHttpUrl(llmsTxtUrl);
  const txt = await fetchUrl(base);
  return extractLlmsTxtLinks(txt, base);
}

/**
 * Extract unique links from llms.txt text. A URL listed more than once keeps
 * the title of its first occurrence; later distinct titles go to `otherTitles`.
 */
export function extractLlmsTxtLinks(txt: string, base: string): LlmsTxtLink[] {
  const links: LlmsTxtLink[] = [];
  const byUrl = new Map<string, LlmsTxtLink>();
  for (const match of txt.matchAll(MD_LINK_RE)) {
    const title = (match[1] || "").trim() || (match[2] || "").trim();
    const href = (match[2] || "").trim();
    if (!href) continue;
    let abs: string;
    try {
      abs = new URL(href, base).toString();
    } catch {
      continue;
    }
    if (!abs.startsWith("http://") && !abs.startsWith("https://")) continue;
    const existing = byUrl.get(abs);
    if (existing) {
      const others = (existing[2] ??= []);
      if (title !== existing[0] && !others.includes(title)) others.push(title);
      continue;
    }
    const link: LlmsTxtLink = [title, abs];
    byUrl.set(abs, link);
    links.push(link);
  }
  if (links.length === 0) {
    const hint = looksLikeHtml(txt) ? " (the response is an HTML page, not an llms.txt)" : "";
    throw new Error(`no markdown links found in ${base}${hint}`);
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
 * Cheap HTML sniff over a bounded prefix instead of lowercasing the whole body
 * (which can be up to MAX_BODY_BYTES = 10 MB). 8 KB comfortably covers a
 * doctype, leading comments, and whitespace before <html>/<head>/<body>.
 *
 * Matching semantics are otherwise unchanged from the previous full-body scan:
 * a case-insensitive substring check for "<html", "<head", or "<body". The only
 * behavioral change is that markers appearing past the first 8 KB no longer
 * trigger HTML handling.
 */
const HTML_SNIFF_PREFIX_BYTES = 8192;

export function looksLikeHtml(raw: string): boolean {
  const prefix = raw.length > HTML_SNIFF_PREFIX_BYTES ? raw.slice(0, HTML_SNIFF_PREFIX_BYTES) : raw;
  const lower = prefix.toLowerCase();
  return lower.includes("<html") || lower.includes("<head") || lower.includes("<body");
}

/**
 * Fetch a doc URL and return cleaned content. Handles markdown (plain) and HTML.
 * Caller is responsible for authorizing the URL against the registry.
 */
export async function fetchAndClean(pageUrl: string): Promise<Page> {
  const url = assertPublicHttpUrl(pageUrl);
  const raw = await fetchUrl(url);
  if (looksLikeHtml(raw)) {
    const extractedTitle = extractHtmlTitle(raw);
    const content = htmlToText(raw);
    const title = extractedTitle || url.split("/").pop() || url;
    return { url, title, content };
  }
  const title = url.split("/").pop() || url;
  return { url, title, content: raw };
}
