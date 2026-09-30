/**
 * llmstxt-doc-search tools: list/search/fetch + runtime source management.
 */
import {
  getSources,
  getSource,
  findSourceForUrl,
  addSourceEntry,
  removeSourceEntry,
  Source,
} from "../utils/registry.js";
import {
  ensureSourceIndexed,
  ensurePage,
  loadPage,
  pageStateFor,
  dropSourceState,
  getSourceState,
  errorReason,
  SourceIndexError,
  SourceState,
} from "../utils/store.js";
import { makeSnippet } from "../utils/text-processor.js";
import { SNIPPET_HYDRATE_MAX } from "../config.js";
import { logger } from "../utils/logger.js";

/**
 * Log a source skipped because it could not be indexed. A failure replayed
 * from the backoff was already logged when it happened, so it goes to debug
 * rather than repeating a warning on every search.
 */
function logIndexSkip(message: string, e: unknown): void {
  if (e instanceof SourceIndexError && e.inBackoff) logger.debug(message, e);
  else logger.warn(message, e);
}

export interface SearchHit {
  source: string;
  url: string;
  title: string;
  score: number;
  snippet: string;
}

function sourceSummary(s: Source) {
  const st = getSourceState(s.name);
  return {
    name: s.name,
    url: s.url,
    indexed: !!st?.indexed,
    docCount: st?.docCount,
    lastIndexed: st?.lastIndexed,
    lastError: st?.lastError,
    lastFailedAt: st?.failedAt !== undefined ? new Date(st.failedAt).toISOString() : undefined,
  };
}

export function docsHome() {
  return {
    server: "llmstxt-doc-search",
    purpose:
      "BM25 search over registered llms.txt documentation indexes. Title-indexed at " +
      "startup, full content fetched on demand. Complements a local/curated knowledge base: " +
      "use this for live, fast-moving public docs (frameworks, AWS guides).",
    sources: getSources().map(sourceSummary),
    how_to: [
      "search_docs(query, source?, k) - rank docs; omit source to search all, or scope to one (e.g. 'strands', 'aws-bedrock-userguide').",
      "fetch_doc(url) - get full content of a result url (must be under the llms.txt directory of a registered source, or listed by one that has been searched).",
      "list_doc_sources() - see configured sources.",
      "add_doc_source(name, llms_txt_url) / remove_doc_source(name) / refresh_doc_source(name) - manage sources at runtime.",
      "Cite the doc url and note it is fetched live (may change).",
    ],
  };
}

export function listDocSources() {
  return { sources: getSources().map(sourceSummary) };
}

function requireSource(name: string): Source {
  const s = getSource(name);
  if (!s) {
    const names = getSources().map((x) => x.name).join(", ");
    throw new Error(`unknown source '${name}'. Available: ${names || "(none)"}`);
  }
  return s;
}

/**
 * Highest-scoring `k` hits with at most one hit per URL. Sources can overlap
 * (e.g. two llms.txt files that list the same page), so the same URL may be
 * collected more than once; the best-scoring copy is kept.
 */
export function topUniqueByUrl<T extends { score: number; uri: string }>(hits: T[], k: number): T[] {
  const sorted = [...hits].sort((a, b) => b.score - a.score);
  const seen = new Set<string>();
  const out: T[] = [];
  for (const h of sorted) {
    if (seen.has(h.uri)) continue;
    seen.add(h.uri);
    out.push(h);
    if (out.length >= k) break;
  }
  return out;
}

export async function searchDocs(
  query: string,
  source: string | undefined,
  k: number
): Promise<{ scope: string; count: number; hint: string; results: SearchHit[] }> {
  const targets = source ? [requireSource(source)] : getSources();

  const collected: { score: number; uri: string; title: string; src: Source; st: SourceState }[] = [];
  for (const src of targets) {
    let st: SourceState;
    try {
      st = await ensureSourceIndexed(src);
    } catch (e) {
      // A named source that cannot be indexed is an error, not an empty result.
      if (source) throw e;
      logIndexSkip(`skip source '${src.name}' (index failed)`, e);
      continue;
    }
    for (const r of st.index.search(query, k)) {
      // Merge on relevance, not raw BM25: raw scores scale with each source's
      // IDF, so a large source would outrank a small one for the same match.
      collected.push({ score: r.relevance, uri: r.doc.uri, title: r.doc.displayTitle, src, st });
    }
  }

  const top = topUniqueByUrl(collected, k);

  // Hydrate the very top hits with content for snippets. Only ensurePage
  // accesses update LRU recency; these search-hit reads intentionally do not,
  // so a result surfaced but never opened does not pin a page in the cache.
  for (const t of top.slice(0, Math.min(top.length, SNIPPET_HYDRATE_MAX))) {
    if (!t.st.urlCache.get(t.uri)) await ensurePage(t.st, t.uri);
  }

  const results: SearchHit[] = top.map((t) => {
    const page = t.st.urlCache.get(t.uri);
    return {
      source: t.src.name,
      url: t.uri,
      title: t.title,
      score: Math.round(t.score * 1000) / 1000,
      snippet: makeSnippet(page?.content ?? null, t.title),
    };
  });

  return {
    scope: source ?? "all",
    count: results.length,
    hint:
      "Ranked by BM25 (stemming + bigrams + markdown weighting). score is 0-1: the fraction of " +
      "the best score this query could reach in that source, so it is comparable across sources. " +
      "Use fetch_doc(url) to read a winner. Content is fetched live and may change.",
    results,
  };
}

/**
 * Find the source that authorizes fetching `url`, in order:
 *  1. an indexed source whose llms.txt lists it, preferring one that already
 *     has the page cached (so a snippet fetch is reused, not repeated);
 *  2. the source with the longest base prefix covering it; if that source
 *     fails to index, the page is still fetched, since the prefix alone
 *     authorizes it.
 * Listed links can live on another host (e.g. raw.githubusercontent.com),
 * which the prefix rule alone rejects; they are authorized once their source
 * is indexed by a search, add_doc_source or refresh_doc_source. Sources are
 * not indexed here just to check their listings, so a URL that no source
 * covers is rejected without fetching every registered llms.txt.
 */
async function resolveFetchSource(url: string): Promise<{ src: Source; st: SourceState } | undefined> {
  let listed: { src: Source; st: SourceState } | undefined;
  for (const src of getSources()) {
    const st = getSourceState(src.name);
    if (!st?.indexed || !st.urlTitles.has(url)) continue;
    if (st.urlCache.get(url)) return { src, st };
    listed ??= { src, st };
  }
  if (listed) return listed;

  const prefixed = findSourceForUrl(url);
  if (!prefixed) return undefined;
  try {
    return { src: prefixed, st: await ensureSourceIndexed(prefixed) };
  } catch (e) {
    logIndexSkip(`source '${prefixed.name}' failed to index; fetching without its index`, e);
    return { src: prefixed, st: pageStateFor(prefixed.name) };
  }
}

/** The URL as the index keys it: parsed, normalized and without its #fragment. */
function normalizeUrl(url: string): string | undefined {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.toString();
  } catch {
    return undefined;
  }
}

export async function fetchDoc(
  url: string
): Promise<{ url: string; title: string; content: string; source?: string; error?: string }> {
  const normalized = normalizeUrl(url);
  const resolved = normalized ? await resolveFetchSource(normalized) : undefined;
  if (!normalized || !resolved) {
    return {
      url,
      title: "",
      content: "",
      error:
        "URL is not under or listed by any registered source. Use search_docs first (a listed link on " +
        "another host is recognized once its source has been searched), or add_doc_source for its llms.txt.",
    };
  }
  const { src, st } = resolved;
  try {
    const page = await loadPage(st, normalized);
    return { url: page.url, title: page.title, content: page.content, source: src.name };
  } catch (e) {
    return { url, title: "", content: "", source: src.name, error: `failed to fetch document: ${errorReason(e)}` };
  }
}

export async function addDocSource(name: string, url: string) {
  // Validate the llms.txt actually parses and yields links before persisting.
  const src = addSourceEntry(name, url);
  try {
    const st = await ensureSourceIndexed(src);
    return { added: sourceSummary(src), docCount: st.docCount };
  } catch (e) {
    // Roll back the registry entry if it cannot be indexed. The source no
    // longer exists, so the index error's refresh_doc_source hint is dropped.
    removeSourceEntry(name);
    dropSourceState(name);
    const reason = e instanceof SourceIndexError ? e.reason : errorReason(e);
    throw new Error(`source '${name}' was not added: its llms.txt failed to index: ${reason}`, { cause: e });
  }
}

export function removeDocSource(name: string) {
  const ok = removeSourceEntry(name);
  if (ok) dropSourceState(name);
  return { removed: ok, name };
}

export async function refreshDocSource(name: string) {
  const src = requireSource(name);
  dropSourceState(name);
  const st = await ensureSourceIndexed(src);
  return { refreshed: name, docCount: st.docCount, lastIndexed: st.lastIndexed };
}
