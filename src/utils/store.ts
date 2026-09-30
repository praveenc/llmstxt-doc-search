/**
 * Multi-source store: one lazily-built BM25 title index per registered source,
 * with on-demand page fetching/caching.
 */
import { parseLlmsTxt, fetchAndClean, Page } from "./doc-fetcher.js";
import { IndexSearch } from "./indexer.js";
import { normalize, indexTitleVariants, formatDisplayTitle } from "./text-processor.js";
import { Source } from "./registry.js";
import { PAGE_CACHE_MAX, INDEX_RETRY_BACKOFF_MS } from "../config.js";
import { logger } from "./logger.js";

export interface SourceState {
  index: IndexSearch;
  urlCache: Map<string, Page | null>;
  urlTitles: Map<string, string>;
  /**
   * URLs with a fetched (non-null) page in `urlCache`, in least- to
   * most-recently-used order. Tracks only cached content, so the `null`
   * placeholders seeded for every known URL never count toward the cap.
   */
  pageLru: Set<string>;
  indexed: boolean;
  docCount: number;
  lastIndexed?: string;
  /** Why the last index attempt failed; cleared by a successful index. */
  lastError?: string;
  /** When the last index attempt failed (epoch ms). */
  failedAt?: number;
}

const states = new Map<string, SourceState>();

function fresh(): SourceState {
  return {
    index: new IndexSearch(),
    urlCache: new Map(),
    urlTitles: new Map(),
    pageLru: new Set(),
    indexed: false,
    docCount: 0,
  };
}

/**
 * Build (once) the title index for a source. Idempotent and cached in memory.
 * A failed attempt is remembered, and further calls within
 * INDEX_RETRY_BACKOFF_MS fail fast with the remembered reason instead of
 * re-fetching the llms.txt.
 */
export async function ensureSourceIndexed(src: Source): Promise<SourceState> {
  const existing = states.get(src.name);
  if (existing && existing.indexed) return existing;
  if (existing?.failedAt !== undefined && Date.now() - existing.failedAt < INDEX_RETRY_BACKOFF_MS) {
    throw new SourceIndexError(
      src.name,
      existing.lastError ?? "unknown error",
      true,
      existing.failedAt + INDEX_RETRY_BACKOFF_MS - Date.now()
    );
  }

  const st = fresh();
  states.set(src.name, st);

  let links: Awaited<ReturnType<typeof parseLlmsTxt>>;
  try {
    links = await parseLlmsTxt(src.url);
  } catch (e) {
    st.lastError = errorReason(e);
    st.failedAt = Date.now();
    throw new SourceIndexError(src.name, st.lastError, false, INDEX_RETRY_BACKOFF_MS, e);
  }
  for (const [title, url, otherTitles] of links) {
    st.urlTitles.set(url, title);
    if (!st.urlCache.has(url)) st.urlCache.set(url, null);
    const displayTitle = normalize(title);
    const variants = indexTitleVariants(displayTitle, url);
    const indexTitle = otherTitles?.length
      ? normalize([variants, ...otherTitles].join(" "))
      : variants;
    st.index.add({ uri: url, displayTitle, content: "", indexTitle });
  }
  st.indexed = true;
  st.docCount = links.length;
  st.lastIndexed = new Date().toISOString();
  logger.info(`indexed source '${src.name}': ${links.length} docs`);
  return st;
}

export function getSourceState(name: string): SourceState | undefined {
  return states.get(name);
}

/**
 * A readable reason for a failure, even when the error's message is empty:
 * falls back to its `code` (e.g. ECONNREFUSED on a failed connect), then its name.
 */
export function errorReason(e: unknown): string {
  if (e instanceof Error) {
    const code = (e as { code?: unknown }).code;
    return e.message || (typeof code === "string" && code) || e.name || "unknown error";
  }
  return String(e) || "unknown error";
}

/**
 * A source's llms.txt could not be indexed. `reason` is the underlying cause
 * without the retry hint; `inBackoff` is true when this attempt failed fast
 * on a remembered failure instead of fetching the llms.txt again.
 */
export class SourceIndexError extends Error {
  constructor(
    readonly source: string,
    readonly reason: string,
    readonly inBackoff: boolean,
    retryInMs: number,
    cause?: unknown
  ) {
    const retryIn = Math.ceil(retryInMs / 1000);
    super(`source '${source}' failed to index: ${reason} (retry in ${retryIn}s, or call refresh_doc_source)`, {
      cause,
    });
    this.name = "SourceIndexError";
  }
}

/**
 * A source's state for page fetches, whether or not its index is built. Used
 * when a source authorizes a URL by prefix but its llms.txt cannot be indexed.
 */
export function pageStateFor(name: string): SourceState {
  let st = states.get(name);
  if (!st) {
    st = fresh();
    states.set(name, st);
  }
  return st;
}

export function dropSourceState(name: string): void {
  states.delete(name);
}

/**
 * Fetch + cache a page's content within a source's state. Throws the fetch
 * error (e.g. `HTTP 404`) so callers can report why a page is unavailable.
 */
export async function loadPage(st: SourceState, url: string): Promise<Page> {
  const cached = st.urlCache.get(url);
  if (cached !== undefined && cached !== null) {
    touchPage(st, url);
    return cached;
  }
  try {
    const raw = await fetchAndClean(url);
    const page: Page = {
      url,
      title: formatDisplayTitle(url, raw.title, st.urlTitles),
      content: raw.content,
    };
    st.urlCache.set(url, page);
    touchPage(st, url);
    evictPages(st);
    return page;
  } catch (e) {
    logger.warn(`fetch failed: ${url}`, e);
    forgetPage(st, url);
    throw e;
  }
}

/** Like loadPage, but a failed fetch yields `null` (logged by loadPage). */
export async function ensurePage(st: SourceState, url: string): Promise<Page | null> {
  try {
    return await loadPage(st, url);
  } catch {
    return null;
  }
}

/**
 * Drop a URL's cached page. A URL the llms.txt lists goes back to its `null`
 * placeholder, so it stays known; any other URL (reached only through the
 * source's base prefix) is removed, so arbitrary query-string variants and
 * failed fetches do not accumulate keys.
 */
function forgetPage(st: SourceState, url: string): void {
  st.pageLru.delete(url);
  if (st.urlTitles.has(url)) st.urlCache.set(url, null);
  else st.urlCache.delete(url);
}

/** Mark a fetched page as most-recently-used. */
function touchPage(st: SourceState, url: string): void {
  st.pageLru.delete(url);
  st.pageLru.add(url);
}

/**
 * Evict least-recently-used fetched pages until the cache is within
 * PAGE_CACHE_MAX (see forgetPage for what is kept). An evicted URL is
 * re-fetched on next access. A cap of 0 disables eviction.
 */
function evictPages(st: SourceState): void {
  if (PAGE_CACHE_MAX <= 0) return;
  while (st.pageLru.size > PAGE_CACHE_MAX) {
    const oldest = st.pageLru.values().next().value;
    if (oldest === undefined) break;
    forgetPage(st, oldest);
  }
}
