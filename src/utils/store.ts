/**
 * Multi-source store: one lazily-built BM25 title index per registered source,
 * with on-demand page fetching/caching.
 */
import { parseLlmsTxt, fetchAndClean, Page } from "./doc-fetcher.js";
import { IndexSearch } from "./indexer.js";
import { normalize, indexTitleVariants, formatDisplayTitle } from "./text-processor.js";
import { Source } from "./registry.js";
import { logger } from "./logger.js";

export interface SourceState {
  index: IndexSearch;
  urlCache: Map<string, Page | null>;
  urlTitles: Map<string, string>;
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
  if (cached !== undefined && cached !== null) return cached;
  try {
    const raw = await fetchAndClean(url);
    const page: Page = {
      url,
      title: formatDisplayTitle(url, raw.title, st.urlTitles),
      content: raw.content,
    };
    st.urlCache.set(url, page);
    return page;
  } catch (e) {
    logger.warn(`fetch failed: ${url}`, e);
    st.urlCache.set(url, null);
    return null;
  }
}
