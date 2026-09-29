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

- A source whose llms.txt 404s or times out is re-fetched on every unscoped
  search: warm unscoped latency goes from ~1 ms to ~330 ms (404) or ~505 ms
  (connect timeout).
- Cause: the state is stored before parsing and never marked failed
  (`src/utils/store.ts:43-46`), so the next call rebuilds it.
- Fix: remember the failure with a short backoff (e.g. 5 minutes), and
  surface it in `list_doc_sources`.

### 9.8 Scoped search on a failing source reports success (Low-Medium)

Issue: #13

- `search_docs(q, source: "<broken>")` returns `{count: 0}` with
  `isError: false`, because the index error is caught and the source skipped
  even when it is the only one requested (`src/tools/docs.ts:83-88`).
- Fix: rethrow when `source` was given.

### 9.9 `fetch_doc` error text can be empty (Low)

Issue: #14

- `fetch_doc` for a URL under a source whose llms.txt fails returns
  `{"content":[{"type":"text","text":""}],"isError":true}`: `fetchDoc`
  awaits `ensureSourceIndexed` (`src/tools/docs.ts:138`) without a catch,
  and the SDK surfaces the empty message of Node's timeout error. Fetching
  a page does not need the index.
- Fix: catch and return a JSON error, or fetch without indexing first.

### 9.10 Logger drops error messages (Low)

Issue: #15

- `src/utils/logger.ts:37` does `JSON.stringify(args)`, which turns an `Error` into
  `{}`: logs read `fetch failed: ... [{}]` and
  `skip source 'x' (index failed) [{}]`. The README asks users to attach
  these logs to bug reports.
- Fix: serialize `Error` as `name: message` (plus `code` when present).

### 9.11 "agent" and "agents" never match each other (Medium, ranking)

Issue: #16

- Both are in `PRESERVE_TERMS` (`src/utils/stopwords.ts:37`), so neither is
  stemmed. On herdr, `search_docs("agents")` finds the "Agents" page and
  `search_docs("agent")` does not.
- Fix: remove them from `PRESERVE_TERMS` (Porter maps both to `agent`), or
  map plural forms of preserved terms to the singular.

### 9.12 URL fragments break titles and caching (Low)

Issue: #17

- `fetch_doc(".../prompt-caching.md#supported-models")` returns the title
  `prompt-caching.md#supported-models` and fetches the page again for every
  distinct fragment.
- Cause: the curated title and cache are keyed on the raw URL
  (`src/utils/text-processor.ts:54`, `src/utils/store.ts`), and the `.md`
  check uses `endsWith` (`text-processor.ts:61`).
- Fix: strip the fragment before lookup, caching and fetching.

### 9.13 `.md` extension becomes a search term (Low)

Issue: #18

- `titleFromUrl` keeps the file extension, so every doc on a `.md` site gets
  an `md` token and bigrams (index title "Global CLI Global Cli.md"), and a
  search for `md` matches all 41 viteplus docs.
- Cause: `src/utils/text-processor.ts:20-35`.
- Fix: strip a trailing `.md`/`.mdx`/`.html` from the slug.

### 9.14 Page-cache keys grow for URLs not in the llms.txt (Low)

Issue: #19

- Every URL ever fetched under a source's base stays in `urlCache` as a
  `null` placeholder after a failure or eviction (`src/utils/store.ts:91`,
  `:115`). 120 authorized query-string variants and 30 404s added 150 keys
  that are never removed. #5 bounds page content, so this is URL strings
  only.
- Fix: on eviction or failure, delete keys that are not in `urlTitles`.

### 9.15 Release housekeeping before v0.2.0

Issue: #20

- `APP_VERSION` is still `"0.1.0"` (`src/config.ts:8`) and is reported in
  `serverInfo`; `package.json` is also 0.1.0.
- `USER_AGENT` is `llmstxt-doc-search/0.1` (`src/utils/doc-fetcher.ts:18`).
- Optional: strip HTML page chrome ("View a markdown version of this page",
  breadcrumbs, "Javascript is disabled") and collapse repeated spaces in
  `htmlToText`; inline `<a name>` anchors are left in markdown bodies.
