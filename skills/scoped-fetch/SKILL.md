---
name: scoped-fetch
description: Explains which URLs fetch_doc can read and what to do with other web pages. Use when fetch_doc rejects a URL, or when the user gives a link that is not from a registered llms.txt documentation source.
---

# Scoped fetch

`fetch_doc(url)` only reads documentation that a registered llms.txt source covers.
There is no arbitrary web fetch in this server.

## What fetch_doc accepts

- A URL under the llms.txt directory of a registered source.
  For example, a source at `https://docs.aws.amazon.com/bedrock/latest/userguide/llms.txt` covers pages under `https://docs.aws.amazon.com/bedrock/latest/userguide/`.
- A URL listed in a source's llms.txt, even on another host, once that source has been indexed by `search_docs`, `add_doc_source` or `refresh_doc_source`.
- Only public `http` and `https` URLs.
  Private and reserved network addresses are always blocked.

## When fetch_doc rejects a URL

The error says the URL is not under or listed by any registered source.

1. If the page belongs to a registered source, run `search_docs` on that source first, then retry `fetch_doc` with a `url` from the results.
2. If the site publishes an llms.txt, add it with `add_doc_source(name, llms_txt_url)` (see `manage-sources`), then search and fetch.
3. For any other web page, use the fetchv2 MCP server if it is available: `fetch` for one URL, `fetch_batch` for several.
   If no general fetch server is available, tell the user this server cannot read that page.
