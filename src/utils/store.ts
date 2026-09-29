/**
 * Multi-source store: one lazily-built BM25 title index per registered source,
 * with on-demand page fetching/caching.
 */
import { parseLlmsTxt, fetchAndClean, Page } from "./doc-fetcher.js";
import { IndexSearch } from "./indexer.js";
import { normalize, indexTitleVariants, formatDisplayTitle } from "./text-processor.js";
import { Source } from "./registry.js";
import { PAGE_CACHE_MAX } from "../config.js";
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

/** Build (once) the title index for a source. Idempotent and cached in memory. */
export async function ensureSourceIndexed(src: Source): Promise<SourceState> {
  const existing = states.get(src.name);
  if (existing && existing.indexed) return existing;

  const st = fresh();
  states.set(src.name, st);

  const links = await parseLlmsTxt(src.url);
  for (const [title, url] of links) {
    st.urlTitles.set(url, title);
    if (!st.urlCache.has(url)) st.urlCache.set(url, null);
    const displayTitle = normalize(title);
    const indexTitle = indexTitleVariants(displayTitle, url);
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

export function dropSourceState(name: string): void {
  states.delete(name);
}

/** Fetch + cache a page's content within a source's state. */
export async function ensurePage(st: SourceState, url: string): Promise<Page | null> {
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
    st.urlCache.set(url, null);
    st.pageLru.delete(url);
    return null;
  }
}

/** Mark a fetched page as most-recently-used. */
function touchPage(st: SourceState, url: string): void {
  st.pageLru.delete(url);
  st.pageLru.add(url);
}

/**
 * Evict least-recently-used fetched pages until the cache is within
 * PAGE_CACHE_MAX. An evicted URL is reset to a `null` placeholder rather than
 * removed, so it stays recognized as a known URL and is re-fetched on next
 * access. A cap of 0 disables eviction.
 */
function evictPages(st: SourceState): void {
  if (PAGE_CACHE_MAX <= 0) return;
  while (st.pageLru.size > PAGE_CACHE_MAX) {
    const oldest = st.pageLru.values().next().value;
    if (oldest === undefined) break;
    st.pageLru.delete(oldest);
    st.urlCache.set(oldest, null);
  }
}
