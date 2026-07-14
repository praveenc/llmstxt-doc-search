# llmstxt-doc-search

An MCP server that **BM25-searches any number of `llms.txt` documentation indexes** (Strands, Kiro, AWS user/dev guides, and any you add at runtime), then fetches full doc content on demand. Built on the search engine from [`@praveenc/mcp-docs-server`](https://github.com/praveenc/mcp-docs-server), generalized to a registry of sources.

## Why

`llms.txt` files are curated link indexes some doc sites publish. They can be huge (AWS Bedrock's is ~1,000 docs). This server indexes only the **titles** at first use (fast, tiny), ranks queries with **BM25 + Porter stemming + bigrams + markdown-aware weighting**, and fetches the full markdown/HTML of a result **on demand**. So you get current docs with near-zero local storage - the right model for broad, fast-moving reference (vs. snapshotting docs into a local vault).

## Tools

| Tool | Purpose |
|------|---------|
| `docs_home()` | Orientation: registered sources + how to search/fetch. Call first. |
| `list_doc_sources()` | List sources (name, llms.txt url, index status). |
| `search_docs(query, source?, k?)` | BM25 search; omit `source` to search all, or scope to one. Returns `{source,url,title,score,snippet}`. |
| `fetch_doc(url)` | Full content of a result url (must belong to a registered source). |
| `add_doc_source(name, llms_txt_url)` | Register + index a new `llms.txt` at runtime (persisted). |
| `remove_doc_source(name)` | Remove a source. |
| `refresh_doc_source(name)` | Re-index a source (pick up changes). |

## Default sources (seeded on first run)

`strands`, `kiro`, `aws-bedrock-userguide`, `aws-agentic-ai-lens`, `aws-bedrock-agentcore-devguide`.
Registry is persisted at `~/.config/llmstxt-doc-search/sources.json` (override with `LLMSTXT_REGISTRY_PATH`).

## Build & run

```bash
npm install
npm run build      # -> dist/
npm test           # offline unit tests
npm run typecheck
```

MCP client config (after `npm run build`):

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

Dev (no build): `"command": "npx", "args": ["tsx", "/ABS/PATH/src/index.ts"]`.

## Config (env)

| Var | Default | Meaning |
|-----|---------|---------|
| `LLMSTXT_REGISTRY_PATH` | `~/.config/llmstxt-doc-search/sources.json` | Where sources are persisted. |
| `LLMSTXT_SNIPPET_HYDRATE_MAX` | `5` | How many top hits to fetch for snippets. |
| `LLMSTXT_LOG_LEVEL` | `info` | `debug`/`info`/`warn`/`error` (stderr only). |

## Security

- `fetch_doc` only fetches URLs **under a registered source's base prefix** (no arbitrary fetch).
- All fetches reject non-`http(s)` schemes and loopback/link-local/private hosts (SSRF guard).

## License

MIT
