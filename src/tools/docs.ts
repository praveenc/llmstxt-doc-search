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
  dropSourceState,
  getSourceState,
  SourceState,
} from "../utils/store.js";
import { makeSnippet } from "../utils/text-processor.js";
import { SNIPPET_HYDRATE_MAX } from "../config.js";
import { logger } from "../utils/logger.js";

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
      "fetch_doc(url) - get full content of a result url (must belong to a registered source).",
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
      logger.warn(`skip source '${src.name}' (index failed)`, e);
      continue;
    }
    for (const r of st.index.search(query, k)) {
      collected.push({ score: r.score, uri: r.doc.uri, title: r.doc.displayTitle, src, st });
    }
  }

  collected.sort((a, b) => b.score - a.score);
  const top = collected.slice(0, k);

  // Hydrate the very top hits with content for snippets.
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
      "Ranked by BM25 (stemming + bigrams + markdown weighting). Scores are within-source; " +
      "use fetch_doc(url) to read a winner. Content is fetched live and may change.",
    results,
  };
}

export async function fetchDoc(
  url: string
): Promise<{ url: string; title: string; content: string; source?: string; error?: string }> {
  const src = findSourceForUrl(url);
  if (!src) {
    return {
      url,
      title: "",
      content: "",
      error:
        "URL is not under any registered source. Use search_docs first, or add_doc_source for its llms.txt.",
    };
  }
  const st = await ensureSourceIndexed(src);
  const page = await ensurePage(st, url);
  if (!page) return { url, title: "", content: "", source: src.name, error: "failed to fetch document" };
  return { url: page.url, title: page.title, content: page.content, source: src.name };
}

export async function addDocSource(name: string, url: string) {
  // Validate the llms.txt actually parses and yields links before persisting.
  const src = addSourceEntry(name, url);
  try {
    const st = await ensureSourceIndexed(src);
    return { added: sourceSummary(src), docCount: st.docCount };
  } catch (e) {
    // roll back the registry entry if it cannot be indexed
    removeSourceEntry(name);
    dropSourceState(name);
    throw new Error(`source '${name}' added but failed to index (rolled back): ${String(e)}`);
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
