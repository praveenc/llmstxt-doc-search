# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
uses [Semantic Versioning](https://semver.org/).

## [0.2.0] - 2026-09-30

Lower memory and CPU, more accurate ranking, and a round of fixes found by
benchmarking v0.1.0 against five real `llms.txt` sites. No tool names or
parameters changed.

### Performance

- Replaced the `natural` dependency with a vendored Porter stemmer and removed
  redundant work from the indexer (#1). Idle RSS drops from 172 MB to 87 MB,
  `initialize` from ~660 ms to ~190 ms, and CPU per single-source run by
  52-66%. In-process search is 61-78% faster.
- The per-source page cache is bounded (LRU, `LLMSTXT_PAGE_CACHE_MAX`,
  default 50) (#5), and cache keys for unlisted URLs are dropped (#31).
- A failing source is skipped for 5 minutes instead of being refetched on
  every search (#26).

### Fixed

- Ranking: BM25 postings and term frequencies are correct (#3); scores are
  comparable across sources in unscoped search (#27); "agent" and "agents"
  match each other (#28); every title gets the same index weight (#41); file
  extensions are no longer search terms (#30).
- Results: duplicate URLs are removed, an `llms.txt` with no links is
  rejected, and snippets skip frontmatter, raw HTML, emphasis-only lines and
  `:::` containers (#22, #39).
- `fetch_doc`: links to other hosts listed in an `llms.txt` can be fetched
  (#23); a page under a source's directory can be fetched when its
  `llms.txt` fails to index (#24); URL `#fragments` are ignored (#29); a
  rejected URL no longer indexes every registered source (#41).
- Errors and logs: error messages are printed instead of `{}` (#25); a scoped
  search on a failing source reports the error (#26); a failed
  `add_doc_source` explains the rollback, and a re-added `llms.txt` that
  differs only in its query or fragment is rejected as a duplicate (#40).
- HTML pages returned by `fetch_doc` drop site chrome (`<nav>`, `<aside>`,
  `<footer>`, and `<header>` outside `<main>`), keep only `<main>` when
  present, and collapse repeated spaces. Empty `<a name>` anchors are
  removed from markdown pages (#20).
- The version reported in `serverInfo` and the `User-Agent` header now come
  from `package.json` (#20).

### Security

- Updated transitive runtime dependencies with published advisories:
  `fast-uri` 3.1.8, `hono` 4.13.11, `@hono/node-server` 1.19.17 (#20).

### Changed

- `fetch_doc` accepts a URL listed in a source's `llms.txt` only after that
  source has been indexed by a search, add or refresh. URLs under a
  registered source's directory work as before (#41).

## [0.1.0] - 2026-07-14

Initial release.

[0.2.0]: https://github.com/praveenc/llmstxt-doc-search/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/praveenc/llmstxt-doc-search/releases/tag/v0.1.0
