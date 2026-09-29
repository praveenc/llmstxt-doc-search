# Improvements

Findings from a memory investigation (2026-09-27) of `llmstxt-doc-search`
v0.1.0 running via `npx`. Each item lists the evidence and the fix.

## 1. Host-side: ~1 GB was the `npm exec` wrapper, not the server

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

Status: fixed in `feat/bounded-url-cache` (issue #4).

- `urlCache` in `store.ts` keeps every fetched page for the process lifetime,
  each up to 10 MB (`MAX_BODY_BYTES`). Only path that grows in long sessions.
- Fix: per-source LRU cap on fetched pages (`LLMSTXT_PAGE_CACHE_MAX`, default
  50, 0 disables). Eviction resets a page to its `null` placeholder, so known
  URLs stay recognized and re-fetch on next access; placeholders never count
  toward the cap.

## 6. Ranking correctness

Status: fixed in `fix/bm25-ranking` (issue #2).

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
- The server has not been migrated to the latest MCP specification revision.
