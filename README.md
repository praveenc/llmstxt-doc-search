# llmstxt-doc-search

> Live, ranked search across any number of `llms.txt` documentation sites - Strands, Kiro, the AWS guides, and whatever you add at runtime.

[![npm version](https://img.shields.io/npm/v/@praveenc/llmstxt-doc-search.svg)](https://www.npmjs.com/package/@praveenc/llmstxt-doc-search)
[![MCP Registry](https://img.shields.io/badge/MCP-Registry-blue)](https://registry.modelcontextprotocol.io/v0.1/servers/io.github.praveenc%2Fllmstxt-doc-search/versions/0.1.0)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/praveenc/llmstxt-doc-search?include_prereleases)](https://github.com/praveenc/llmstxt-doc-search/releases)

`llmstxt-doc-search` is a Model Context Protocol (MCP) server that turns the `llms.txt` index a documentation site publishes into a fast, ranked search tool your agent can call. It indexes titles at startup, ranks queries with BM25, and fetches the full document only when you open a result - so you get current docs with almost no local storage. Built on the search engine from [`@praveenc/mcp-docs-server`](https://github.com/praveenc/mcp-docs-server), generalized to a runtime registry of sources.

---

## Why

An `llms.txt` file is a curated index of a doc site's pages, published for tools like this one to consume. They can be large - AWS Bedrock's lists roughly a thousand documents - so downloading everything is wasteful and goes stale fast.

This server takes a leaner approach:

- **Title-only index, built lazily.** On first search of a source, only the page titles are indexed. That is fast to build and tiny to hold in memory.
- **Ranked with BM25.** Queries are scored with BM25 plus Porter stemming, bigrams, and markdown-aware weighting (headers, code, and links count for more). Technical terms like `mcp`, `json`, and `stdio` are preserved rather than stemmed.
- **Content on demand.** The full markdown or HTML of a result is fetched only when you call `fetch_doc`.

The result is a good fit for broad, fast-moving reference material - the opposite tradeoff to snapshotting docs into a local vault.

---

## Installation

### Quick start (recommended)

Add the server to your MCP client configuration (Claude Desktop, Kiro, and others). It is downloaded and run on demand via `npx` - no manual build:

```json
{
  "mcpServers": {
    "llmstxt-doc-search": {
      "command": "npx",
      "args": ["-y", "@praveenc/llmstxt-doc-search"]
    }
  }
}
```

### Global install

```bash
npm install -g @praveenc/llmstxt-doc-search
```

Then point your MCP client at the installed binary:

```json
{
  "mcpServers": {
    "llmstxt-doc-search": {
      "command": "llmstxt-doc-search"
    }
  }
}
```

---

## Quick start

Once the server is connected, the typical flow is three calls:

1. **`docs_home()`** - orient yourself: see the registered sources and how to search and fetch.
2. **`search_docs("prompt caching", "aws-bedrock-userguide")`** - rank matching docs. Omit the source to search everything.
3. **`fetch_doc(url)`** - read the full content of a result you like.

Add your own source at any time and it is indexed immediately and persisted for future runs:

```
add_doc_source("langgraph", "https://langchain-ai.github.io/langgraph/llms.txt")
```

---

## Tools

| Tool | Purpose |
|------|---------|
| `docs_home()` | Orientation: registered sources plus how to search and fetch. Call this first. |
| `list_doc_sources()` | List sources with their `llms.txt` URL and index status. |
| `search_docs(query, source?, k?)` | BM25 search. Omit `source` to search all, or scope to one. Returns ranked `{source, url, title, score, snippet}`. `k` defaults to 5 (max 50). |
| `fetch_doc(url)` | Fetch the full content of a result URL. The URL must belong to a registered source. |
| `add_doc_source(name, llms_txt_url)` | Register and index a new `llms.txt` source at runtime. Persisted. |
| `remove_doc_source(name)` | Remove a registered source. |
| `refresh_doc_source(name)` | Re-index a source to pick up new or changed docs. |

### Default sources

Seeded into the registry on first run:

`strands`, `kiro`, `aws-bedrock-userguide`, `aws-agentic-ai-lens`, `aws-bedrock-agentcore-devguide`, `mcp`.

The registry is persisted at `~/.config/llmstxt-doc-search/sources.json` (override with `LLMSTXT_REGISTRY_PATH`). Anything you add, remove, or refresh at runtime is saved there.

---

## Configuration

All configuration is via environment variables; none are required.

| Variable | Default | Meaning |
|----------|---------|---------|
| `LLMSTXT_REGISTRY_PATH` | `~/.config/llmstxt-doc-search/sources.json` | Where the source registry is persisted. |
| `LLMSTXT_SNIPPET_HYDRATE_MAX` | `5` | How many top hits to fetch when building result snippets. |
| `LLMSTXT_LOG_LEVEL` | `info` | Log verbosity: `debug`, `info`, `warn`, or `error`. Logs go to stderr only. |

---

## Testing with MCP Inspector

```bash
npx @modelcontextprotocol/inspector npx -y @praveenc/llmstxt-doc-search
```

---

## Development

Clone the repository for local work:

```bash
git clone https://github.com/praveenc/llmstxt-doc-search.git
cd llmstxt-doc-search
npm install
```

### Commands

```bash
npm run dev         # run from source with tsx (no build)
npm test            # offline unit tests
npm run typecheck   # type-check without emitting
npm run build       # compile to dist/
npm run inspect:dev # MCP Inspector against the source
```

### Local MCP client config (development)

Point your client at a source checkout instead of the published package:

```json
{
  "mcpServers": {
    "llmstxt-doc-search": {
      "command": "npx",
      "args": ["tsx", "/ABS/PATH/llmstxt-doc-search/src/index.ts"]
    }
  }
}
```

Or, after `npm run build`, at the compiled entry point:

```json
{
  "mcpServers": {
    "llmstxt-doc-search": {
      "command": "node",
      "args": ["/ABS/PATH/llmstxt-doc-search/dist/index.js"]
    }
  }
}
```

---

## Architecture

```text
src/
├── index.ts              # MCP server entry point and tool registration
├── config.ts             # Defaults and environment configuration
├── tools/
│   └── docs.ts           # search_docs, fetch_doc, and source management
└── utils/
    ├── doc-fetcher.ts    # HTTP fetching, redirect handling, HTML parsing
    ├── indexer.ts        # BM25 search index
    ├── registry.ts       # Persisted source registry
    ├── store.ts          # In-memory document store
    ├── text-processor.ts # Tokenization and snippet helpers
    ├── url-validator.ts   # SSRF guard and URL validation
    ├── stopwords.ts      # Stop-word list
    └── logger.ts         # Logging utilities
```

---

## Search algorithm

Ranking uses BM25 (Best Matching 25) with several enhancements:

- **Porter stemming** matches word variants (for example, `running` and `run`).
- **Bigrams** capture phrase matches (for example, `prompt caching`).
- **Weighted scoring** boosts title matches (3-8x), headers (4x), code blocks (2x), and link text (2x).
- **Domain-term preservation** keeps technical terms like `mcp`, `json`, and `stdio` unstemmed so they match exactly.

---

## Security

This server fetches user-supplied URLs at runtime, so its SSRF surface is guarded in depth:

- **Scoped fetches.** `fetch_doc` only retrieves URLs under a registered source's origin and path prefix, matched on a path boundary rather than a raw string prefix. There is no arbitrary fetch.
- **Scheme allow-list.** Non-`http(s)` schemes are rejected.
- **Range-based address blocking.** Private and reserved destinations are blocked using IP range classification (`ipaddr.js`), covering decimal, octal, and hex IPv4, IPv4-mapped IPv6, loopback, link-local, unique-local, carrier-grade NAT, and other reserved ranges - not just a hostname regex.
- **Connection-time validation.** The resolved IP is checked at connection time via a custom DNS lookup, closing DNS-rebinding, and every redirect hop is re-validated.
- **Bounded responses.** Response bodies are capped at 10 MB to limit memory and regular-expression (ReDoS) exposure.

Runtime dependencies report zero known vulnerabilities.

---

## License

[MIT](LICENSE) - Copyright (c) 2026 Praveen Chamarthi

---

## Contributing

Contributions are welcome. If you find a bug or have an idea:

1. Open an issue describing the problem or proposal.
2. For code changes, fork the repo and create a feature branch.
3. Keep changes focused, add or update tests, and make sure `npm test`, `npm run typecheck`, and `npm run build` all pass.
4. Open a pull request against `main` with a clear description of what changed and why.

Commit messages follow the [Conventional Commits](https://www.conventionalcommits.org/) style.

---

## Support

- **Questions and ideas:** open a [GitHub issue](https://github.com/praveenc/llmstxt-doc-search/issues).
- **Bugs:** please include your MCP client, the tool call you made, and any relevant logs (set `LLMSTXT_LOG_LEVEL=debug` for more detail).
- **Security issues:** open an issue marked as security-sensitive, or contact the maintainer directly rather than posting exploit details publicly.

---

<div align="center">
  <sub>Built for the MCP community ❤️</sub>
</div>
