---
name: docs-lookup
description: Look up current documentation from registered llms.txt sources (Strands, Kiro, AWS Bedrock, Bedrock AgentCore, Well-Architected agentic AI lens, MCP, and any added at runtime). Use when the user asks how an API, SDK, framework or AWS service works and wants a cited, up-to-date answer.
---

# Docs lookup

Answer from live documentation in three calls, and cite the page you read.

## Steps

1. Call `docs_home()` to see the registered sources and their index status.
   Skip it if you already know the source names in this session.
2. Call `search_docs(query, source?, k?)`.
   - Pass `source` (for example `strands`, `kiro`, `aws-bedrock-userguide`, `aws-bedrock-agentcore-devguide`, `aws-agentic-ai-lens`, `mcp`) when the question clearly belongs to one source.
   - Omit `source` to search all sources.
   - `k` defaults to 5 and is capped at 50.
   - Results are ranked `{source, url, title, score, snippet}`. `score` is 0-1 and comparable across sources.
3. Call `fetch_doc(url)` on the best result, using the `url` exactly as returned.
   Fetch a second result only if the first does not answer the question.
4. Answer from the fetched content and cite the live `url`.
   Content is fetched live and may change, so do not present it as a fixed snapshot.

## When results are poor

- Rephrase with the product's own terms (API names, feature names) and search again.
- If a scoped search finds nothing, retry without `source`.
- A named `source` that cannot be indexed returns an error.
  Searching all sources skips a failing source instead.
  See the `manage-sources` skill to retry it with `refresh_doc_source`.
- If the docs are not in any registered source, say so.
  Offer to add the site's llms.txt (see `manage-sources`) or, for a non-llms.txt page, see `scoped-fetch`.
