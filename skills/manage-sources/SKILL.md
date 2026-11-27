---
name: manage-sources
description: Add, refresh or remove llms.txt documentation sources in llmstxt-doc-search. Use when the user wants to search a doc site that is not registered yet, when a source fails to index or looks stale, or when the user asks to drop a source.
---

# Manage doc sources

Sources live in a persisted registry, so changes last across runs.
Call `list_doc_sources()` to see each source's name, llms.txt URL and index status, including `lastError` for a failing source.

## Add a source

1. Find the site's llms.txt URL (usually `https://<docs-host>/llms.txt`).
2. Call `add_doc_source(name, llms_txt_url)` with a short id for `name`, for example `langgraph`.
3. The source is indexed at once.
   On success the result includes `docCount`.
   If the llms.txt cannot be fetched or has no links, nothing is saved and the call returns an error.
   An already registered name or llms.txt URL is also rejected.

## Refresh a source

- Call `refresh_doc_source(name)` to re-index from its llms.txt and pick up new or changed docs.
- A source whose llms.txt failed to index is skipped for 5 minutes.
  `refresh_doc_source` retries it at once, so use it after a fix instead of waiting.

## Remove a source

- Call `remove_doc_source(name)`.
  It is marked destructive: it deletes the source from the persisted registry.
- Only remove a source the user asked to remove.

## Confirmation

`add_doc_source` and `remove_doc_source` take an optional `confirm` flag.
On a client that can show a prompt, the server asks the user before it changes the registry.
Let the user answer it, and do not retry after they decline.
If a result returns `confirmation_required: true` or `reason: "cancelled"`, nothing was changed.
Ask the user in chat, and call again with `confirm: true` only after they agree.
Never pass `confirm: true` on your own.
