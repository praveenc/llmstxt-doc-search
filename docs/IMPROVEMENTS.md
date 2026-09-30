# Improvements

Findings from a memory investigation (2026-09-27) of `llmstxt-doc-search`
v0.1.0 running via `npx`. Each item lists the evidence and the fix.

## 1. Host-side: ~1 GB was the `npm exec` wrapper, not the server

Status: not a server bug; host workaround below. The server-side share of
the footprint is addressed by #1 (see section 8).

- Observed: `npm exec @praveenc/llmstxt-doc-search` peaked at ~991 MiB RSS
  (VmHWM 1,015,780 kB); the server process (`node .../llmstxt-doc-search`)
  peaked at 186 MB.
- Cause: the npx cache lockfile
  (`~/.npm/_npx/<hash>/package-lock.json`) had grown to 40 MB with 33,181
  entries (33,033 `extraneous`). Keys repeat `local/` up to 232 times. `$HOME`
  (`/home/<user>`) is a symlink to `/local/home/<user>`, which sits one level
  deeper; npm writes the tree as a path relative to the realpath and resolves
  it against the symlinked path next launch, adding one layer per launch.
- Reproduced: a fresh cache behind a depth-mismatched symlink grew from 70 KB
  to 221 KB in 3 launches; a same-depth symlink stayed at 148 entries.
- Impact per launch with the bloated lockfile: npm peak ~890 MB, ~80 s delay
  before the server spawns, ~250 MB resident for the session.
- Fixes (no functional change):
  - Delete the affected `~/.npm/_npx/<hash>` directory once.
  - Run npm with a realpath cache (`npm_config_cache=/local/home/<user>/.npm`).
  - Best: `npm i -g @praveenc/llmstxt-doc-search@<version>` and launch
    `node <global>/dist/index.js` directly (no npm wrapper process at all).
  - README: document the global-install config as the low-memory option.

## 2. Dependency bloat: `natural`

Status: fixed in #1 (vendored Porter stemmer; `natural` removed).

- Used only for `PorterStemmer` (`src/utils/indexer.ts`).
- Import alone adds ~117 MB RSS / ~54 MB heap (node baseline 41 MB -> 158 MB).
- Pulls mongoose, mongodb, bson, redis, pg, memjs, wordnet-db (~100 MB of a
  140 MB node_modules).
- Calls `dotenv.config()` in 5 storage modules; dotenv v17 prints
  `◇ injected env ...` to stdout, which is the stdio JSON-RPC channel, and
  loads any `.env` in the cwd into the server environment.
- Fix: replace with a small zero-dependency Porter stemmer.

## 3. Indexer wasted work

Status: fixed in #1.

- `calculateBM25Score` re-lowercases content/title and re-runs three regex
  extractions per query token, per candidate doc, per query.
- `add()` recomputes the average doc length with a full `reduce` on every
  insert (O(n^2) build).
- `content` is always `""` in `store.ts`, so header/code/link weighting never
  contributes in production.
- Fix: precompute lowercased fields and markdown extracts once per doc at
  `add()`; keep a running length total; skip extraction when content is empty.

## 4. Fetcher: full-body lowercase copy

Status: fixed in #1 (`looksLikeHtml()` checks the first 8 KB).

- `fetchAndClean` lowercases the whole body (up to 10 MB) just to detect HTML.
- Fix: check only a bounded prefix (first few KB).

## 5. Unbounded page cache

Status: fixed in #5 (issue #4).

- `urlCache` in `store.ts` keeps every fetched page for the process lifetime,
  each up to 10 MB (`MAX_BODY_BYTES`). Only path that grows in long sessions.
- Fix: per-source LRU cap on fetched pages (`LLMSTXT_PAGE_CACHE_MAX`, default
  50, 0 disables). Eviction resets a page to its `null` placeholder, so known
  URLs stay recognized and re-fetch on next access; placeholders never count
  toward the cap.

## 6. Ranking correctness

Status: fixed in #3 (issue #2).

- Posting lists contained duplicate doc ids (one push per token occurrence),
  so `search()` added a doc's score once per duplicate and a repeated term
  scored linearly instead of saturating.
- Bigram tokens (`a_b`) and stemmed tokens were counted by substring against
  raw lowercased text, which never contains `_` and often not the stem, so
  bigrams scored 0 and stems like `queri` (from `query`) scored 0.
- Fix: postings are recorded once per doc; `add()` builds a per-doc weighted
  term-frequency map from the same token stream used for indexing (title x
  boost, headers x4, code/link x2, content x1), and scoring reads it.
- Effect on the parity corpus: 15/40 queries changed top-1 and 23/40 changed
  top-5, mostly promoting exact title matches. The parity fixture is now
  regenerated with `test/fixtures/generate-search-parity.ts`.
- Left as-is: header/code/link text is also counted inside `content`, so those
  matches get field weight + 1; cross-field bigrams are indexed but score 0.
  Neither affects production, where `content` is always `""`.

## 7. Other

- The same pattern (depth-mismatched `$HOME` symlink) is starting to inflate
  other npx caches on the same machine (e.g. `@playwright/mcp`, 505 KB).
- The server has not been migrated to the latest MCP specification revision
  (2026-07-28). Status: planned; see
  [mcp-spec-migration-0728.md](mcp-spec-migration-0728.md).

## 8. Benchmark: v0.1.0 (npm) vs main after #1, #3, #5

Run 2026-09-29 on main `5f997c5` (Node 24, Linux). Both versions were
installed from tarballs (`npm i @praveenc/llmstxt-doc-search@0.1.0` vs
`npm pack` of main) and driven over MCP stdio from a fresh registry.
Sources: strandsagents.com (895 links), Bedrock user guide (1116),
modelcontextprotocol.io (354), viteplus.dev (41), herdr.dev (see 9.1), plus
one session with all five added on top of the 6 defaults. Medians of 3
alternating runs per version; in-process index numbers from 3+ runs.

| Metric | v0.1.0 | main | Change |
|---|---|---|---|
| `node_modules` size | 99 MB | 24 MB | -76% |
| Module import (time / RSS) | ~512 ms / 107 MB | ~51 ms / 13 MB | -90% |
| `initialize` response | 641-685 ms | 183-192 ms | -71% |
| Idle RSS | 172 MB | 87 MB | -49% |
| RSS after add (Bedrock, 1116 docs) | 209 MB | 116 MB | -44% |
| Final RSS, single source | 200-239 MB | 106-124 MB | -46..-50% |
| Final RSS, 11-source session + 150 fetches | 266 MB | 167 MB | -37% |
| Index build per doc | 21-42 us | 19-35 us | -5..-18% |
| Search, in-process (mean per query) | 13-71 us | 7-28 us | -49..-73% |
| Total CPU per single-source run | 780-1230 ms | 270-530 ms | -57..-65% |
| Non-JSON lines on stdout | 5 (dotenv) | 0 | fixed |
| Pages held after 300 fetches (1 source) | 300 | 50 | capped |
| Index heap (Bedrock) | 1.64 MB | 2.66 MB | +62% (per-doc TF map, #3) |

- `add_doc_source`, cold `search_docs` and `fetch_doc` times are dominated by
  network (the 5 snippet fetches per cold search); no meaningful difference.
  Warm search over JSON-RPC sits at the ~0.4 ms round-trip floor in both.
- Page-cache cap shows functionally (re-opening an evicted page goes back to
  the network) but barely in RSS on these sources, because the pages are
  small (Bedrock median ~5 KB). Most of the RSS gain is removing `natural`.
- Ranking over 38 queries: main better on 16, tied on 21, slightly worse on
  1 (Bedrock "how can I reduce latency and cost of repeated prompts": Prompt
  caching falls from #4 to outside the top 5 because `cost-mgmt-*` URL slugs
  lift "Projects"/"Workspaces"). v0.1.0 returned score-0 filler on 2 of 8
  Strands queries; main no longer does.
- Scores are on a different scale from v0.1.0 (a single-term title match is
  roughly half); clients relying on absolute scores will see new numbers.
  Since 9.6 (#11) was fixed, `search_docs` reports a 0-1 relevance instead
  of raw BM25.

### Per-source results (medians)

| Source (links) | Metric | v0.1.0 | main | Change |
|---|---|---|---|---|
| Strands (895) | Final RSS / VmHWM | 212 / 212 MB | 116 / 117 MB | -46% |
| | Search, in-process (mean of 8 queries) | 50.7 us | 13.8 us | -73% |
| | Worst query (NL MCP question) | 147 us | 26.5 us | -82% |
| | RSS after 80 page fetches | 203 MB | 116 MB | -43% |
| | Pages held / heap after 300 fetches | 300 / 5.9 MB | 50 / 1.2 MB | capped |
| | Ranking (8 queries) | | | main better on 5, tied on 3 |
| Bedrock (1116) | Final RSS | 239 MB | 124 MB | -48% |
| | Index build (per doc) | 46.5 ms (41.6 us) | 37.9 ms (34.0 us) | -18% |
| | Search, in-process | 70.6 us | 27.7 us | -61% |
| | VmHWM after 120 page fetches | 213 MB | 120 MB | -44% |
| | Ranking (8 queries) | | | main better on 5, tied on 2, worse on 1 |
| MCP (354) | Final RSS | 229 MB | 116 MB | -50% |
| | Search, in-process | 42.2 us | 16.2 us | -62% |
| | Total CPU | 1130 ms | 490 ms | -57% |
| Vite+ (41) | Final RSS | 200 MB | 106 MB | -47% |
| | Search, in-process | 18.0 us | 8.8 us | -51% |
| | Ranking (MCP + Vite+, 16 queries) | | | main better on 2, tied on 14 |
| herdr (`/llms.txt`, 26) | Final RSS | 190 MB | 99 MB | -48% |
| | Search, in-process | 13.4 us | 6.8 us | -49% |
| 11 sources, 5,814 docs | RSS after unscoped searches | 263 MB | 164 MB | -38% |
| | First unscoped search (indexes 6 defaults) | 457 ms / 330 ms CPU | 363 ms / 170 ms CPU | -21% / -48% |
| | Warm unscoped search | 0.49-1.36 ms | 0.44-0.82 ms | -18..-48% (one query +0.19 ms) |
| | Total CPU | 1530 ms | 920 ms | -40% |
| | Ranking (6 unscoped queries) | | | main better on 4, tied on 2 |

Other observations from the runs:

- The page cache only matters for memory on sites with large pages. Fetching
  all 893 Strands pages costs 258 MB RSS on v0.1.0 vs 149 MB on main, and
  the whole site is only 4.9 M chars; the rest of the gap is `natural`.
- A broken source does not break unscoped search, but slows it (9.7).
- In the 11-source session, Strands and the Bedrock user guide took 25-26 of
  36 unique top-10 slots in both versions; `aws-agentic-ai-lens` got none
  (9.6).
- Bedrock pages are served as markdown with inline `<a name>` anchors. Its
  `.html` pages clean up usably but keep page chrome (9.15).
- `herdr.dev/docs/llms.txt` is an HTML page; the real index is
  `herdr.dev/llms.txt`, and 22 of its 26 links are on
  `raw.githubusercontent.com` (9.1, 9.2).
- Benchmark caveats: the four runs shared one host and network; cold search,
  add and fetch timings are network-bound; warm JSON-RPC timings sit at a
  ~0.4 ms floor, so in-process search time is the fair comparison. Sources
  registered on the same llms.txt as a default (e.g. `b-bedrock`) route
  `fetch_doc` to the default (9.4), which added the same overhead to both
  versions.

## 9. Bugs found during the benchmark

All reproduced over MCP stdio. Every item is also present in v0.1.0; none
were introduced by #1, #3 or #5. Line numbers are main `5f997c5`. Each item
is tracked as a GitHub issue (#6-#20).

### 9.1 Empty llms.txt is accepted and persisted (Medium)

Issue: #6

Status: fixed in #22. `parseLlmsTxt` throws
when a file yields no links (naming an HTML response), so `add_doc_source`
rolls the source back and reports the reason.

- `add_doc_source("b-herdr", "https://herdr.dev/docs/llms.txt")` returns
  `{docCount: 0}` with `isError: false`. That URL serves an HTML page with no
  markdown links; the source is written to `sources.json`, listed as
  `indexed: true`, and every search returns 0 hits. Herdr's real index is
  `https://herdr.dev/llms.txt`.
- Cause: `addDocSource` only rolls back on a thrown error
  (`src/tools/docs.ts:144-154`), and `ensureSourceIndexed` never checks for
  zero links (`src/utils/store.ts:57`).
- Fix: fail (and roll back) when `parseLlmsTxt` yields no links; mention the
  response content type in the error.

### 9.2 Off-host llms.txt links are searchable but not fetchable (High for affected sources)

Issue: #7

Status: fixed in #23. `fetch_doc` also authorizes
any URL a registered source's llms.txt lists exactly, on any host; the
prefix rule still covers everything else. Unlisted URLs on other hosts are
still rejected. Live: `raw.githubusercontent.com` results from
`herdr.dev/llms.txt` now fetch.

- 22 of 26 links in `https://herdr.dev/llms.txt` point to
  `raw.githubusercontent.com`. They show up in `search_docs`, and the server
  even fetches them to build snippets, but `fetch_doc` rejects them with
  "URL is not under any registered source".
- Cause: `findSourceForUrl` only authorizes URLs under the llms.txt directory
  (`src/utils/registry.ts:86-103`); snippet hydration calls `ensurePage`
  with no such check (`src/tools/docs.ts:101`).
- Fix: also authorize any URL the source's llms.txt lists (look it up in the
  source's `urlTitles`), and keep the prefix rule for everything else.

### 9.3 Duplicate URLs are indexed and returned more than once (Medium)

Issue: #8

Status: fixed in #22. Links are deduped by
URL at parse time (first title is the display title; later distinct titles
are added to the index title so they stay searchable), merged results keep
one hit per URL, and `add_doc_source` rejects an `llms.txt` that is already
registered. Because only the first title is stored per URL, `fetch_doc` and
search now report the same title for a duplicated URL. Live: Strands 893,
MCP 349, Kiro 250 docs; "example servers" and "hooks" return distinct URLs.

- Repeated URLs inside one llms.txt are each indexed as a separate doc:
  Strands 895 links / 893 unique, MCP 354 / 349, Kiro 259 / 250.
  `search_docs("example servers", "b-mcp", 5)` returns
  `modelcontextprotocol.io/examples.md` five times;
  `search_docs("hooks", "kiro", 10)` returns `kiro.dev/docs/hooks.md` at #1
  and #2. `docCount` over-reports by the same amount.
- The same llms.txt URL can also be registered under a second name, and
  unscoped results are merged without URL dedupe; in an 11-source session
  24 of 60 result slots were duplicates.
- For a duplicated URL, `fetch_doc` returns the last title in the file
  (`urlTitles.set` overwrites), while search shows the first.
- Cause: `src/utils/store.ts:49-57` (no dedupe, `docCount = links.length`);
  `src/tools/docs.ts:94` (merge without dedupe); `src/utils/registry.ts:113`
  (only the name is checked for duplicates).
- Fix: dedupe links by URL in `ensureSourceIndexed` (keep the first title,
  optionally fold the others into `indexTitle`); dedupe merged hits by URL;
  warn or reject when a new source's URL is already registered.

### 9.4 `fetch_doc` resolves to the first matching source, not the one searched (Low-Medium)

Issue: #9

Status: fixed in #23. `fetch_doc` first uses an
indexed source whose llms.txt lists the URL, preferring one that already has
the page cached, so a page fetched for a snippet is reused rather than
fetched again. Otherwise the longest matching base wins. A source is indexed
only when no indexed source lists the URL.

- With `b-bedrock` registered on the same llms.txt as the default
  `aws-bedrock-userguide`, `fetch_doc` of a Bedrock URL reports
  `source: "aws-bedrock-userguide"`, downloads and indexes that source's
  llms.txt a second time, and fetches again a page the searched source had
  already cached for its snippet. The page can end up cached in two sources.
- Cause: `findSourceForUrl` returns the first prefix match
  (`src/utils/registry.ts:86`); `fetchDoc` then indexes that source
  (`src/tools/docs.ts:128-139`).
- Fix: prefer a source whose index already lists the URL, then the longest
  matching base.

### 9.5 Snippets are boilerplate, frontmatter or raw HTML (Medium)

Issue: #10

Status: fixed in #22. `makeSnippet` strips
leading frontmatter and empty `<a name|id>` anchors, and skips blockquotes,
`:::` containers, tag-only lines and horizontal rules; list items must be
followed by a space. Live snippets for MCP, Vite+ and Bedrock now show the
first paragraph of the page.

- modelcontextprotocol.io (Mintlify): every snippet is the same
  `> ## Documentation Index > Fetch the complete documentation index at ...`
  block.
- viteplus.dev (VitePress): snippets are frontmatter, e.g.
  `url: /guide/cache.md`.
- Bedrock: snippets are `<a name="prov-throughput"></a>` or start with that
  anchor; a paragraph starting with `**bold**` is treated as a list item and
  skipped.
- Cause: `makeSnippet` (`src/utils/text-processor.ts:100-140`) does not skip
  leading blockquotes, YAML frontmatter (`---` is skipped as a list marker,
  then `url: ...` is accepted as prose) or anchor-only HTML lines, and treats
  any line starting with `*` as a list item.
- Fix: strip a leading `---` frontmatter block and leading `>` blockquote
  lines, drop HTML-tag-only lines, and match list items as `^[-*+]\s` /
  `^\d+\.\s` instead of a bare leading character.

### 9.6 Scores from different sources are merged as if comparable (Medium)

Issue: #11

Status: fixed in #27. Each hit now carries a
`relevance`: its BM25 score divided by the highest score the query could
reach in that source (the sum of `idf * (K1 + 1)` over the query's terms
and bigrams). Unscoped search merges on it, and `search_docs` reports it
as `score` (0-1). Ranking within one source is unchanged. Live, default
sources: `search_docs("sampling", k: 6)` now returns the six MCP
"Sampling" pages (before: AWS "Sample code" pages via the `sampl` stem),
and "hooks" puts Kiro's Hooks page first. Over 16 mixed queries (top 10
each), Strands and the Bedrock user guide went from 82 to 57 of 155
slots, and every source gained or held except those two. Remaining
limitation: several versioned pages with the same title (e.g. MCP spec
revisions) can fill the top results.

- The response hint says "Scores are within-source", but unscoped search
  sorts all sources by raw BM25 score (`src/tools/docs.ts:94`). IDF depends
  on corpus size (a term in one doc: ln 28 = 3.33 in a 41-doc source vs
  ln 745 = 6.61 in a 1116-doc source), so small sources and terms repeated
  across versioned pages lose. `search_docs("sampling", k: 6)` returns no
  MCP result although MCP has 6 pages titled "Sampling".
- Fix: normalize per source before merging (e.g. divide by the source's top
  score, or interleave per-source top hits), or drop the merged ranking in
  favour of per-source result groups.

### 9.7 A failing source is retried on every search (Medium)

Issue: #12

Status: fixed in #26. A failed index attempt is
remembered with its reason; for the next 5 minutes
(`INDEX_RETRY_BACKOFF_MS`) the source fails fast without re-fetching its
llms.txt, and `refresh_doc_source` retries at once. `list_doc_sources`
shows `lastError` and `lastFailedAt`. Live, with Strands plus a 404
source: warm unscoped search 10-13 ms before, 1 ms after.

- A source whose llms.txt 404s or times out is re-fetched on every unscoped
  search: warm unscoped latency goes from ~1 ms to ~330 ms (404) or ~505 ms
  (connect timeout).
- Cause: the state is stored before parsing and never marked failed
  (`src/utils/store.ts:43-46`), so the next call rebuilds it.
- Fix: remember the failure with a short backoff (e.g. 5 minutes), and
  surface it in `list_doc_sources`.

### 9.8 Scoped search on a failing source reports success (Low-Medium)

Issue: #13

Status: fixed in #26. `search_docs` with a
`source` that fails to index returns `isError` with the reason (e.g.
`source 'broken' failed to index: HTTP 404`); unscoped search still skips
failing sources.

- `search_docs(q, source: "<broken>")` returns `{count: 0}` with
  `isError: false`, because the index error is caught and the source skipped
  even when it is the only one requested (`src/tools/docs.ts:83-88`).
- Fix: rethrow when `source` was given.

### 9.9 `fetch_doc` error text can be empty (Low)

Issue: #14

Status: fixed in #24. When the source whose
directory covers the URL fails to index, `fetch_doc` logs a warning and
fetches the page anyway, since the prefix alone authorizes it; a failed
page fetch returns `"failed to fetch document"`. The `fetch_doc` handler
also catches unexpected errors and returns a JSON error with the message,
like the other tools. Live: with the source's llms.txt returning 404, a
Strands page fetches (6,189 chars). Repeated calls no longer re-request
the failing llms.txt since 9.7 (#12) was fixed.

- `fetch_doc` for a URL under a source whose llms.txt fails returns
  `{"content":[{"type":"text","text":""}],"isError":true}`: `fetchDoc`
  awaits `ensureSourceIndexed` (`src/tools/docs.ts:138`) without a catch,
  and the SDK surfaces the empty message of Node's timeout error. Fetching
  a page does not need the index.
- Fix: catch and return a JSON error, or fetch without indexing first.

### 9.10 Logger drops error messages (Low)

Issue: #15

Status: fixed in #25. Each extra log argument
is formatted on its own: an `Error` becomes `name: message`, with
`(code=...)` when present, its `cause` chain and any `AggregateError`
sub-errors (up to 3 levels); strings print as-is and other values as JSON.
Live: `skip source 'gone' (index failed) [{}]` now reads
`... Error: HTTP 404`, and a DNS failure reads
`Error: getaddrinfo ENOTFOUND no-such-host.invalid (code=ENOTFOUND)`.

- `src/utils/logger.ts:37` does `JSON.stringify(args)`, which turns an `Error` into
  `{}`: logs read `fetch failed: ... [{}]` and
  `skip source 'x' (index failed) [{}]`. The README asks users to attach
  these logs to bug reports.
- Fix: serialize `Error` as `name: message` (plus `code` when present).

### 9.11 "agent" and "agents" never match each other (Medium, ranking)

Issue: #16

Status: fixed in #28. `agent` and `agents` are
no longer in `PRESERVE_TERMS`, so the Porter stemmer maps both (and
`agentic`, as before) to `agent`; `AgentCore` stays whole. Live on herdr:
`search_docs("agent")` now returns "Agents" first, and "agents" also
returns the "Agent automation" and "Agent guide" pages. The tokenize and
search parity fixtures were refreshed: 7 of 203 tokenize strings
(`agents` -> `agent`) and 5 of 40 search queries changed.

- Both are in `PRESERVE_TERMS` (`src/utils/stopwords.ts:37`), so neither is
  stemmed. On herdr, `search_docs("agents")` finds the "Agents" page and
  `search_docs("agent")` does not.
- Fix: remove them from `PRESERVE_TERMS` (Porter maps both to `agent`), or
  map plural forms of preserved terms to the singular.

### 9.12 URL fragments break titles and caching (Low)

Issue: #17

Status: fixed in #29. The `#fragment` is dropped before a
URL is used as a lookup, cache or fetch key: in `fetch_doc`, in
`fetchAndClean`, and when parsing llms.txt (anchors into one page become
one entry; their titles stay searchable). URL-derived titles also ignore
the fragment and query string. Live on Bedrock: `fetch_doc` of
`prompt-caching.md#supported-models` now returns the title "Prompt
caching" and the page URL, and two more fetches with other fragments are
served from the cache (1 ms each, before 13-14 ms re-fetches).

- `fetch_doc(".../prompt-caching.md#supported-models")` returns the title
  `prompt-caching.md#supported-models` and fetches the page again for every
  distinct fragment.
- Cause: the curated title and cache are keyed on the raw URL
  (`src/utils/text-processor.ts:54`, `src/utils/store.ts`), and the `.md`
  check uses `endsWith` (`text-processor.ts:61`).
- Fix: strip the fragment before lookup, caching and fetching.

### 9.13 `.md` extension becomes a search term (Low)

Issue: #18

Status: fixed in #30. `titleFromUrl` drops a
trailing `.md`, `.mdx`, `.markdown`, `.html`, `.htm` or `.txt` from the
slug, so the extension no longer becomes a title word or search term;
other dots are kept (`strands.event_loop.md` -> "Strands.event Loop").
`formatDisplayTitle` treats any bare file name with one of those
extensions (not only `.md`) as no title. Live on viteplus: a search for
`md` went from 41 hits (every page) to 0; the top results for "global
cli", "cache" and "migrate" are unchanged. The search parity fixture's
corpus is a fixed input captured before this fix, so its index titles
still contain the extension; it tests the indexer, not title building.

- `titleFromUrl` keeps the file extension, so every doc on a `.md` site gets
  an `md` token and bigrams (index title "Global CLI Global Cli.md"), and a
  search for `md` matches all 41 viteplus docs.
- Cause: `src/utils/text-processor.ts:20-35`.
- Fix: strip a trailing `.md`/`.mdx`/`.html` from the slug.

### 9.14 Page-cache keys grow for URLs not in the llms.txt (Low)

Issue: #19

Status: fixed in #31. When a page is evicted
or its fetch fails, a URL the llms.txt lists goes back to its `null`
placeholder, and any other URL is removed from `urlCache`. Keys are now
bounded by the listed URLs plus `LLMSTXT_PAGE_CACHE_MAX`. Live on
Strands with a cap of 5, 20 query-string variants of one page and 10
missing pages left 30 extra keys before and 5 (the cached pages) after.

- Every URL ever fetched under a source's base stays in `urlCache` as a
  `null` placeholder after a failure or eviction (`src/utils/store.ts:91`,
  `:115`). 120 authorized query-string variants and 30 404s added 150 keys
  that are never removed. #5 bounds page content, so this is URL strings
  only.
- Fix: on eviction or failure, delete keys that are not in `urlTitles`.

### 9.15 Release housekeeping before v0.2.0

Issue: #20

Status: fixed in #42.

- `APP_VERSION` is read from `package.json`, and the User-Agent is
  `llmstxt-doc-search/<version>`. A test checks that `package.json`,
  `package-lock.json` and `server.json` carry the same version.
- `htmlToText` keeps only `<main>` when the page has one, removes `<nav>`,
  `<aside>`, `<footer>` (and `<header>` outside `<main>`) and the `<head>`,
  and collapses repeated spaces. Nothing site-specific is matched. Output
  size on real pages, before and after:

  | Page | Before | After |
  |---|---|---|
  | Kiro `/docs/hooks/` | 11,888 chars | 7,327 (-38%) |
  | MCP `/docs/getting-started/intro` | 4,131 | 2,339 (-43%) |
  | Vite+ `/guide/` | 16,875 | 5,596 (-67%) |
  | herdr `/docs/` | 2,713 | 1,880 (-31%) |
  | Bedrock `prompt-caching.html` | 28,713 | 28,267 (-2%) |

  AWS pages mark their chrome with `<div>`s and custom elements, so the
  Bedrock `.html` page keeps it. Its `llms.txt` links to the `.md` pages,
  which are not affected.
- Empty `<a name>`/`<a id>` anchors are removed from markdown pages (19 on
  Bedrock's prompt-caching page).
- Also found while preparing the release:
  - `npm pack` from a clean checkout produced a tarball without `dist/`.
    A `prepack` script now cleans and builds, and `prepublishOnly` runs the
    typecheck and tests.
  - `npm audit --omit=dev` reported `fast-uri` (high) and `hono` /
    `@hono/node-server` (moderate), all transitive through the MCP SDK.
    Updated in the lockfile to 3.1.8, 4.13.11 and 1.19.17; runtime
    dependencies now report 0 vulnerabilities. The remaining advisories are
    in dev dependencies (vitest 2 / esbuild / postcss) and need a vitest
    major upgrade.

## 10. Benchmark round 2: v0.1.0 vs main after the bug fixes

Run 2026-09-30. Three installs, driven over MCP stdio with medians of 3
interleaved runs, plus in-process index runs:

- `v0.1.0`: the npm tarball.
- `prev`: main `5f997c5`, the refactor only (section 8).
- `main`: `299d237`, the refactor plus #22-#31 (issues #6-#19).

Sources: the five URLs from section 8, plus the real herdr index
(`herdr.dev/llms.txt`). All three still report version 0.1.0 (#20).

| Metric | v0.1.0 | prev | main | main vs v0.1.0 |
|---|---|---|---|---|
| `initialize` response | 641-684 ms | 185-190 ms | 185-190 ms | -71% |
| Idle RSS | 172 MB | 87 MB | 87 MB | -49% |
| Final RSS, Strands (893 docs) | 203 MB | 114 MB | 113 MB | -44% |
| Final RSS, Bedrock (1128 docs) | 214 MB | 118 MB | 118 MB | -45% |
| Final RSS, MCP / Vite+ | 205 / 199 MB | 111 / 103 MB | 111 / 102 MB | -46 / -49% |
| RSS after fetching all 893 Strands pages | 264 MB | 127-134 MB | 134-136 MB | -49% |
| Multi-source session: final RSS | 265 MB | 166 MB | 143 MB | -46% |
| Multi-source session: registered sources | 12 | 12 | 8 | duplicates rejected |
| Total CPU per single-source run | 840-1130 ms | 310-460 ms | 330-470 ms | -52..-66% |
| Search in-process, Strands / Bedrock / MCP | 65 / 106 / 15 us | 13 / 32 / 5.4 us | 14 / 36 / 5.7 us | -61..-78% |
| Warm search over JSON-RPC, Bedrock | 0.51 ms | 0.37 ms | 0.45 ms | -10% |
| Index heap, Bedrock | 1.67 MB | 2.64 MB | 2.21 MB | +32% |
| Index build, Bedrock | 47 ms | 42 ms | 42 ms | -11% |
| Warm unscoped search, 1 source with a 404 llms.txt | 10.8 ms | 10.9 ms | 1.0 ms | -91% |
| Duplicate-URL result slots, multi-source session | 43 / 120 | 41 / 120 | 0 / 120 | fixed |
| Non-JSON lines on stdout | 5 | 0 | 0 | fixed |

- main keeps the refactor's memory and CPU gains, and gets back 16% of the
  index heap that #3 added on Bedrock.
- Against prev, main is slightly slower in two places:
  - Warm Bedrock search over JSON-RPC is 0.02-0.12 ms slower. Snippets
    are built from the real first paragraph now (#10), which takes 1.2-2.3x
    as long.
  - In-process searches containing "agent" are 29-54% slower (+7 us on
    Strands). This is the cost of #16: "agent" and "agents" now share one
    term, which matches more pages. It is still about 3.5x faster than
    v0.1.0.
- In the multi-source session, main registers 8 sources instead of 12,
  because it rejects the three duplicate llms.txt files and the HTML herdr
  page. Part of that session's RSS and CPU saving comes from indexing less.
- The first cold unscoped search is slower on main (1.3 s vs 0.35 s):
  since #11, its top 5 for "sampling" are MCP spec pages, which take about
  0.2 s each to fetch for snippets.
- Network-bound timings (add, cold search, fetch) were the same across
  versions within noise.

Fixes confirmed on the live sources (v0.1.0 and prev behave the same
unless noted):

| Issue | v0.1.0 / prev | main |
|---|---|---|
| #6 add `herdr.dev/docs/llms.txt` | accepted, 0 docs, saved | error "the response is an HTML page", not saved |
| #7 fetch a listed `raw.githubusercontent.com` page | rejected | fetched (6,242 chars); unlisted raw URLs still rejected |
| #8 docCount Strands / MCP; "example servers" distinct URLs in top 5 | 895 / 354; 1 | 893 / 349; 5 |
| #8 same llms.txt under a second name | accepted | rejected |
| #9 fetch after searching a second source on the same llms.txt | second index build and page GET (81-87 ms) | no rebuild or refetch (2 ms) |
| #10 snippets on Bedrock / MCP / Vite+ | 40/40 `<a name>`, 25/25 banner, 17/17 frontmatter | 0 / 0 / 0; first paragraph |
| #11 unscoped slots, MCP / agentic-ai-lens (of 120) | 6 / 0 (v0.1.0), 9 / 1 (prev) | 30 / 8 |
| #12 source with a 404 llms.txt | re-fetched every search; no reason shown | backed off; `lastError: "HTTP 404"` |
| #13 scoped search on that source | `isError: false`, 0 results | `isError` with the reason |
| #14 real page under a failing source's prefix | error "HTTP 404" (the llms.txt's error) | fetched |
| #15 failure log line | `[{}]` | `Error: ... HTTP 404 (retry in 300s, ...)` |
| #16 "agent" vs "agents" (herdr top 3) | different | identical |
| #17 fetch `prompt-caching.md#supported-models` + 2 more fragments | title keeps the fragment; 4 GETs | "Prompt caching"; 1 GET |
| #18 Vite+ search "md" | 41 hits | 0 hits |
| #19 Strands urlCache keys after 60 `?v=` variants + 20 404s | 973 | 943 (893 listed + 50 cached) |

## 11. Findings from benchmark round 2

Each item is tracked as a GitHub issue (11.N is #(N+31), #32-#38), and
each was reproduced on the live sources. 11.1 and 11.2 are regressions
against prev that the bug-fix round introduced. The rest were already
present or are side effects of a fix. Code references are to main
`299d237`.

### 11.1 Title weight now depends on the URL slug (Medium, ranking, regression from #18)

Issue: #32

Status: fixed in #41. `indexTitleVariants` indexes
the display title once and adds only the words of the slug (and of the
"2 -> to" variant) that are not already in it. Words are compared as index
tokens, stemmed and with stop words dropped, so `flows` does not repeat
"flow" and `evaluation` does not repeat "Evaluate". Every title now has the
same weight whether or not its slug restates it. Ranking check against prev
(`5f997c5`) and main (`32ccf74`), within each source:

| Check | prev | main | fixed |
|---|---|---|---|
| Bedrock "prompt" -> Prompt caching | 1 | >10 | 1 |
| Bedrock "reduce latency and cost of repeated prompts" -> Prompt caching | 13 | 23 | 13 |
| Bedrock "flows" -> Flows | 1 | 1 | 1 |
| Top-5 shared with prev: Bedrock / Strands / MCP (15/15/10 queries) | - | 51/75, 56/75, 48/50 | 55/75, 66/75, 48/50 |

Two Bedrock landing pages rank lower than in prev, because their extra title
weight came only from the slug:

- "model evaluation" -> "Evaluate models" (`evaluation.md`): 1 in prev and
  main, 82 now. The title does not contain the phrase; prev matched it only
  through the bigram `model evalu` formed across the title and its
  `Evaluation.md` slug. Pages whose titles contain "model evaluation" now
  rank first, and "evaluate models" still ranks the page first.
- "agents" -> "Agents: Automate tasks": 1 in prev, 2 in main, 5 now, behind
  shorter titles such as "Delete an agent".

- `indexTitleVariants` (`src/utils/text-processor.ts`) drops a slug
  variant only when it matches the title exactly, ignoring case.
  - Before #18 the `.md` suffix meant the slug never matched, so every
    title was indexed twice.
  - Now a title whose slug equals it is indexed once: "Prompt caching"
    becomes `Prompt caching`, where prev had `Prompt caching Prompt
    Caching.md`.
  - A slug that differs only by punctuation still doubles the title:
    "What is prompt engineering?" becomes `What is prompt engineering?
    What Is Prompt Engineering`.
- On Bedrock 37 of 1128 titles lost the second copy, mostly topic landing
  pages: Prompt caching, Prompt management, Batch inference, Flows, Quotas.
- Rank of "Prompt caching" on Bedrock:

| Query | prev | main |
|---|---|---|
| "prompt" | 1 | 11 (top hit: "What is prompt engineering?") |
| "reduce latency and cost of repeated prompts" | 13 | 23 |

  "prompt caching" still ranks it first, but "Prompt management" drops
  out of that query's top 3.
- Fix: compare variants with punctuation removed (`normalizeForComparison`),
  and give each title a fixed weight that does not depend on whether the
  slug repeats it.

### 11.2 `*...*` emphasis lines become snippets (Low-Medium, regression from #10)

Issue: #33

Status: fixed in #39. `makeSnippet` skips
lines wrapped entirely in one emphasis span (`*...*`, `**...**`, `_..._`),
and skips a line that is only a link or image when no prose has started
yet. A link on its own line inside a paragraph is kept, because
hard-wrapped prose puts links there (MCP "Security Best Practices"). Live
check against the snippets on the current base: all 14 Strands Lesson pages
now start at "About this lesson ..." instead of `*[Watch on YouTube](...)*`.
Bedrock loses leading `**Note**`, `**Important**` and `**Topics**` labels
(9 of 81 sampled pages). MCP working-group pages lose their
`**Working Group**` label (4 of 70), so they now show the group's
description instead of the label.

- #10 made list items need a following space (`LIST_ITEM_RE`), so a line
  such as `*[Watch on YouTube](https://...)*` now counts as prose. prev
  skipped every line starting with `*`.
- 4 of the 14 Strands "Lesson" pages now have a snippet starting with
  `*[Watch on YouTube](...)*`, where prev started at "About this lesson...".
- Fix: also skip lines that are only emphasis or a link, e.g.
  `^\*[^*\s].*\*$` and `^\[[^\]]*\]\([^)]*\)$`.

### 11.3 `:::` block content becomes the snippet (Low)

Issue: #34

Status: fixed in #39. `makeSnippet` drops
each `:::` container along with its contents before it looks for prose.
Nesting is tracked by depth, and a container with no closing `:::` runs to
the end of the page, as in markdown-it-container. Live on Vite+ "GitHub
Actions Cache", the snippet is now the page's first paragraph ("Vite Task
stores task results in `node_modules/.vite/task-cache` ..."). It was the
experimental warning. No other page among the 41 Vite+ pages changed.

- `isNonProseLine` skips the `::: warning` fence line but not the text inside
  the block. Vite+ "GitHub Actions Cache" gets the warning text ("Reusing
  Vite Task's cache ... is experimental") as its snippet.
- Fix: skip everything from a `:::` opening line to its closing `:::`.

### 11.4 The first rejected `fetch_doc` indexes every source (Low-Medium, side effect of #7)

Issue: #35

Status: fixed in #41. `resolveFetchSource` no
longer indexes every source to look for the URL in its llms.txt. A URL is
authorized when an indexed source lists it, or when it is under a
registered source's directory. A listed link on another host is recognized
once its source has been indexed by a search, `add_doc_source` or
`refresh_doc_source`; before that, the error says to search first. Live on a
fresh server: rejecting a URL that no source covers took 636 ms and built 6
indexes before, and takes 4 ms and builds none now.

- On a fresh server, fetching a URL that no source lists takes 637-685 ms
  and 270 ms of CPU, builds all 6 default indexes, and grows RSS from 87 MB
  to about 120 MB before it is rejected. v0.1.0 and prev reject it in 3-6 ms.
- Cause: `resolveFetchSource` indexes every not-yet-indexed source to
  check its listing (`src/tools/docs.ts`).
- Fix: only index a source on demand when the URL's host matches a host the
  source's llms.txt is known to link to, or skip the check and let search
  results be the way to reach off-host pages.

### 11.5 A failed add suggests `refresh_doc_source` for a rolled-back source (Low)

Issue: #36

Status: fixed in #40. Index failures are now a
`SourceIndexError` that carries the bare reason. When `add_doc_source` rolls
a source back, it reports `source '<name>' was not added: its llms.txt
failed to index: <reason>`, without the retry or `refresh_doc_source` hint.
Live with herdr's HTML docs page: the message no longer points to a
`refresh_doc_source` call that would fail with "unknown source", and the
nested `Error: ... Error: ...` prefixes are gone.

- A failed `add_doc_source` returns "... (rolled back): ... (retry in 300s,
  or call refresh_doc_source)". The source no longer exists, so
  `refresh_doc_source` then fails with "unknown source".
- Fix: strip the retry hint from the rollback message, or build the hint
  only in search and `list_doc_sources`.

### 11.6 Versioned pages with the same title fill the results (Medium, ranking)

Issue: #37

Status: not fixed in v0.2.0; #37 is now an enhancement, "Index URL path
segments to tell same-titled pages apart". The fix proposed below was
dropped: keeping one hit per title would hide distinct pages on other sites
(Strands has 16 different "Overview" pages, Bedrock 93 groups of repeated
titles), and a check for a version segment in the URL matches every AWS URL
through `/latest/`. The index holds only titles, so no query can currently
choose between the versions. The site-agnostic alternative is to index each
URL's path segments at a low weight.

- MCP publishes each spec page once per version (2024-11-05 ... 2026-07-28,
  draft). "sampling" and "tools" return the same page in six versions. In
  the multi-source session MCP takes 6-7 of the top 10 slots for "sampling",
  "tools", "mcp server" and "security best practices for agents".
- This was already true in a scoped MCP search. #11 now brings it into
  unscoped results as well, because MCP is no longer outranked.
- Fix: group results by (source, displayTitle) and keep the best hit per
  group (optionally preferring URLs without a date or `draft` segment).

### 11.7 Smaller items (Low)

Issue: #38

Status: fixed in #40. All four items:

- Backoff logging: a failure replayed from the backoff is marked
  `inBackoff` and its skip is logged at DEBUG. Only the attempt that
  actually fetched the llms.txt logs WARN. Live, with one broken source and
  3 unscoped searches: 3 WARN lines before, 1 after.
- `fetch_doc` of a missing page now returns `failed to fetch document:
  HTTP 404`. A failed connect with an empty message reports its code
  (`ECONNREFUSED`). The new `loadPage` throws the fetch error, and
  `ensurePage` keeps returning `null` for snippet hydration.
- The duplicate check compares origin and path only, so
  `.../llms.txt?v=2` and `.../llms.txt#top` are rejected as the source that
  is already registered.
- A rejected `add_doc_source` input (`URLValidationError`: bad name,
  duplicate, private host) is logged at INFO, and a failed index at WARN,
  instead of ERROR. Every tool's error `message` is now the bare reason,
  without `Error:` or `URLValidationError:` prefixes.

Details of the four items:

- During the 5-minute backoff, every unscoped search still logs one WARN
  line for the failing source.
- `fetch_doc` of a missing page returns "failed to fetch document"; the HTTP
  status (404) is only in the log. v0.1.0 returned "HTTP 404".
- The #8 duplicate check compares normalized URLs, so the same llms.txt with
  a query string (`.../llms.txt?v=2`) registers as a second source. In that
  setup an unscoped search can cache the same page in both sources.
- A failed duplicate add is logged at ERROR level with a
  `URLValidationError:` prefix in the tool message.
