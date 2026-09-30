# Migrating llmstxt-doc-search to MCP spec 2026-07-28

Status: implemented in #43 (#21), released as 1.0.0 · Date: 2026-09-29 · Baseline: `main` @ `5f997c5` (package `0.1.0`)

Implementation notes (2026-09-30), where the shipped change differs from this proposal:

- 5.4 was already done in 0.2.0: `APP_VERSION` is read from `package.json`.
- 5.3 (`outputSchema` + `structuredContent`) is deferred to a follow-up, as recommended.
- The codemod (step 2 of Section 6) was not used. `src/index.ts` was edited by hand, since the `buildServer` wrapper touches every registration anyway.
- `fetch_doc` and `add_doc_source` use `z.url()`, which replaces the deprecated `z.string().url()`.
- The version is 1.0.0, not 0.3.0 as Section 10 recommends. The tool names, parameters and result fields have not changed since 0.1.0, so from this release they are the stable API under semver. The bump (5.1 line 3, 5.7) is a separate commit in the same PR.
- `test/protocol.test.ts` (5.6) is written: 12 tests. 9 of them fail against the v1 server on `main`.

## 1. Summary

The server speaks only the legacy, handshake-based protocol (`initialize` → `2025-11-25` and earlier). It is built on `@modelcontextprotocol/sdk@1.29.0` (installed; the `1.x` line's latest, `1.31.0`, still tops out at `2025-11-25`). A client pinned to `2026-07-28` cannot connect to it today: measured, it fails with `SdkError ERA_NEGOTIATION_FAILED` (Section 3).

To migrate:

1. Swap `@modelcontextprotocol/sdk@^1` for the v2 package `@modelcontextprotocol/server@^2.2.0`. v2 implements `2026-07-28`.
2. Bump `zod` to `^4.2.0` and Node to `>=20`.
3. Replace `server.connect(new StdioServerTransport())` with `serveStdio(buildServer)`. This makes the server dual-era: modern clients are served statelessly and legacy clients still get `initialize`.
4. Declare cache hints (`ttlMs`/`cacheScope`), `listChanged: false`, and tool annotations. Optionally add `outputSchema` + `structuredContent`.

Almost all the protocol code is in one file: `src/index.ts`, the only file that imports the SDK (verified with grep). The search engine, registry, SSRF guard, fetcher, and logger need no changes.

I tried this in a throwaway copy of the repo. It type-checks, all 49 existing tests pass, and one build serves legacy, `auto`-negotiating, and `2026-07-28`-pinned clients (Section 9).

## 2. What changed in 2026-07-28 and what it means here

Source: [Key Changes](https://modelcontextprotocol.io/specification/2026-07-28/changelog.md) and [Deprecated Features](https://modelcontextprotocol.io/specification/2026-07-28/deprecated.md).

| Spec change | Affects this server? | Action |
|---|---|---|
| `initialize`/`initialized` handshake removed; each request carries `_meta` protocol version, capabilities, and client info (SEP-2575) | Yes. The v1 SDK only understands the handshake. | Serve through v2 `serveStdio`, which handles both eras. |
| `server/discover` is **MUST** implement (SEP-2575) | Yes. It isn't implemented today. | Provided by v2 (`McpServer` + `serveStdio`). |
| Every result carries `resultType` (SEP-2322) | Yes | The v2 SDK adds it; no code change. |
| `tools/list` and `server/discover` results **MUST** carry `ttlMs` + `cacheScope` (SEP-2549) | Yes | SDK defaults to `ttlMs: 0, cacheScope: "private"`. Set real hints with `ServerOptions.cacheHints`. |
| `tools/list` **SHOULD** use a deterministic order | Already true (registration order) | Keep registration order stable. Don't sort per request. |
| No per-connection variation of `tools/list`; cross-call state goes in explicit handles (SEP-2567) | Already compliant: the 7 tools are static | None. See 7.1 on registry state. |
| `ping` and `logging/setLevel` removed; the Logging feature is deprecated (SEP-2577), with migration "log to `stderr`" | Already compliant: `src/utils/logger.ts` writes only to stderr | None. Don't adopt `ctx.mcpReq.log()`. |
| Roots, Sampling, and Elicitation move to MRTR (`input_required`) (SEP-2322/2577) | Not used | None |
| `resources/subscribe` and the GET stream are replaced by `subscriptions/listen` | Not used | Advertise `tools.listChanged: false` so clients don't open a listen stream for nothing. |
| Input schemas default to JSON Schema 2020-12; `structuredContent` can be any JSON value (SEP-2106) | Yes. v2 + zod 4 emit 2020-12 with `$schema`. | Automatic. Optionally add `outputSchema`. |
| Unknown tool is a protocol error (`-32602`); input validation failures are tool execution errors (`isError: true`) | Behaviour changes on upgrade | Verified in the spike (Section 9). No code needed. |
| Tasks moved to an extension; HTTP+SSE deprecated; `Mcp-Session-Id`, `Last-Event-ID`, and `x-mcp-header` changes | Not applicable (stdio only, no tasks) | None |
| Authorization changes (`iss`, CIMD, DCR deprecation) | Not applicable (no auth on stdio) | None |

## 3. Current state (evidence)

- `package.json:52` declares `"@modelcontextprotocol/sdk": "^1.0.0"`. The installed version is `1.29.0`, whose `LATEST_PROTOCOL_VERSION = '2025-11-25'`.
- `@modelcontextprotocol/sdk@1.31.0` (the latest `1.x`, published 2026-09-28) also has `LATEST_PROTOCOL_VERSION = '2025-11-25'`, with no `server/discover`. **The v1 line will not get you to 2026-07-28.**
- `@modelcontextprotocol/server@2.2.0` README: "v2 is the stable release line, implementing the 2026-07-28 MCP spec." It defines `FIRST_MODERN_PROTOCOL_VERSION = "2026-07-28"`.
- Running the current `dist/index.js` against a v2 client:

  ```text
  modern-pin FAILED: SdkError ERA_NEGOTIATION_FAILED Version negotiation failed: the server did not
             offer pinned protocol version 2026-07-28 via server/discover (no fallback in pin mode)
  auto       connected era= legacy
  ```

  This matches the spec's compatibility matrix: Modern client against a Legacy server → **Fails**. Dual-era client against a Legacy server → Works, but only on the legacy path.

## 4. Why migrate: what gets better

Each point is marked by whether it is required by the new spec or only made easy by the SDK upgrade, and whether I measured it.

1. **Modern-only clients can use the server (spec, measured).** Today a client that pins `2026-07-28` can't connect. After migration, the same build answers pinned, `auto`, and legacy clients (Section 9). As hosts move to modern-only negotiation, a legacy-only server stops working without any error on the server side. This is the main reason to migrate.

2. **No handshake round-trip; every request stands alone (spec, measured).** A modern client can send `tools/call` as the first line on stdin with no `initialize`/`initialized` exchange. The spike answered a raw `tools/list` sent that way. The saving is one round-trip per process start. That's small in absolute terms, but it matters for an `npx`-spawned server whose pitch is "one `search_docs` + one `fetch_doc` (lean, few round-trips)" (`src/index.ts:37`, `:76`). Restart recovery also gets simpler: the stdio spec says in-flight requests "are simply lost and the client can retry them against the fresh process". There is no session to rebuild.

3. **Tool list caching and stable LLM prompt caches (spec, measured on the wire).** With `cacheHints` the `tools/list` response carries `ttlMs: 3600000, cacheScope: "public"` (verified in the raw response). The tool set only changes when the package version changes, so clients can skip re-listing for an hour and can share the list across users. The spec links deterministic order to "LLM prompt cache hit rates when tools are included in model context". The tool definitions (about 2 KB of descriptions) stay byte-identical, so the host's model prompt cache keeps hitting. The server itself pays nothing for this.

4. **A much smaller install for `npx` users (SDK, measured).** Production dependency tree: **91 packages / 24 MB → 3 packages / 16 MB**. v1 pulls in `express`, `hono`, `@hono/node-server`, `cors`, `jose`, `eventsource`, `ajv`, `pkce-challenge`, `cross-spawn`, and others, none of which a stdio docs server uses. The v2 server package depends only on `@modelcontextprotocol/core` and `zod`. Less to download on a cold `npx -y`, and 88 fewer transitive packages to track for vulnerabilities and supply-chain risk. That fits the "zero known vulnerabilities" claim in `README.md:216`.

5. **Clearer tool semantics for hosts (SDK-enabled; annotations predate 2026).** `readOnlyHint`, `openWorldHint`, `destructiveHint`, and `idempotentHint` let a host auto-approve `search_docs`/`fetch_doc`/`docs_home` and prompt only for `remove_doc_source`. The spec treats these as untrusted hints, so the effect varies by client. They're cheap to add while you're editing the registrations.

6. **Typed results (SDK-enabled, verified for one tool).** With `outputSchema` plus `structuredContent`, clients get validated JSON instead of parsing `JSON.stringify(data, null, 2)` out of a text block (`src/index.ts:43-48`). Keep the text block too; the spec says tools with structured content SHOULD also return serialized JSON text for backward compatibility.

7. **Sturdier stdio handling (SDK).** v2 caps the stdio read buffer at 10 MB and skips non-JSON stdout lines instead of erroring. The second one guards against the class of bug fixed earlier with the `natural`/dotenv stdout leak (`test/deps.test.ts`). Behaviour also follows the spec's error model: unknown tool → `-32602`, bad arguments → `isError` result the model can correct (verified).

What does **not** improve: resident memory. Measured RSS after `tools/list` is about 87 MB for both v1 and v2 (86.0–87.6 MB across runs). Time to first response is within noise (149–170 ms). `docs/IMPROVEMENTS.md`'s memory work stays independent of this migration.

## 5. File-by-file changes

Line numbers refer to `main` @ `5f997c5`.

### 5.1 `package.json`: required

| Line | Current | Change | Why |
|---|---|---|---|
| 3 | `"version": "0.1.0"` | Bump (see Section 10) | Breaking runtime requirements (Node 20, zod 4) |
| 20 | `inspect:dev` script | No change needed. Optionally add `inspect:modern` (see 5.9). | The Inspector handles both protocol eras |
| 48-50 | `"engines": { "node": ">=18.0.0" }` | `">=20"` | v2 packages declare `engines.node >=20` |
| 52 | `"@modelcontextprotocol/sdk": "^1.0.0"` | Remove. Add `"@modelcontextprotocol/server": "^2.2.0"` | Only v2 implements 2026-07-28. `^1.0.0` is also dangerously wide. |
| 54 | `"zod": "^3.24.0"` | `"zod": "^4.2.0"` | v2 requires zod ≥4.2. With zod 3 the server starts but the first `tools/list` fails at runtime. The codemod warns about this but does not fix it. |
| devDependencies | none for MCP | Add `"@modelcontextprotocol/client": "^2.2.0"` | Needed for the new protocol tests (5.6) |

`@modelcontextprotocol/core` does not need to be declared; it comes in transitively and we don't import raw `*Schema` constants.

### 5.2 `src/index.ts`: required (the core of the migration)

| Lines | Current | Change | Why |
|---|---|---|---|
| 6 | `import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"` | `import { McpServer } from "@modelcontextprotocol/server"` | v2 package layout |
| 7 | `import { StdioServerTransport } from ".../server/stdio.js"` | `import { serveStdio } from "@modelcontextprotocol/server/stdio"` | A bare `server.connect(new StdioServerTransport())` in v2 still speaks **only** 2025-era. `serveStdio` is the entry that serves `2026-07-28` (and legacy by default). |
| 8 | `import { z } from "zod"` | Keep (now zod 4) | Must be the same zod ≥4.2 so `.describe()` text reaches the generated JSON Schema |
| 26-41 | module-level `const server = new McpServer(...)` | Wrap in `function buildServer(): McpServer { ... return server; }` | `serveStdio` takes a **factory** and pins one instance per connection and era |
| 28 (options) | `{ instructions }` only | Add `capabilities: { tools: { listChanged: false } }` and `cacheHints: { "tools/list": { ttlMs: 3_600_000, cacheScope: "public" }, "server/discover": { ttlMs: 3_600_000, cacheScope: "public" } }` | Cache fields are required on these results, and the defaults (`0`/`private`) disable caching. `listChanged: false` is accurate (the tool set is static) and stops the SDK from advertising `listChanged: true`, which invites a pointless `subscriptions/listen` stream. `public` is correct: no user-specific data. |
| 29-40 | `instructions` | Keep | Delivered via `server/discover` (modern) or `initialize` (legacy). Modern clients may skip `discover`, so they may never see `instructions`. That's why `docs_home` stays the documented first call (7.3). |
| 43-48 | `json()` helper | Keep. Optionally extend to also return `structuredContent` (5.3). | Text content stays valid on both eras |
| 55, 64 | `inputSchema: {}` | `inputSchema: z.object({})` (or `z.object({}).strict()`) | The raw-shape overloads are `@deprecated` in v2. `.strict()` yields the spec-recommended `additionalProperties: false` for no-arg tools. |
| 78-85 | raw shape `{ query, source, k }` | `z.object({ ... })` | Same. The codemod does this automatically but leaves odd indentation. Re-indent by hand; the repo has no formatter. |
| 103-105, 118-121 | `z.string().url()` | Wrap in `z.object`. Optionally `z.url()`. | `z.string().url()` still works in zod 4 but is deprecated there |
| 137, 146 | inline raw shapes | `z.object({ name: z.string()... })` | Same |
| 50-155 (each `registerTool` config) | no `title`/`annotations` | Add `title` and `annotations` per 5.2.1 | Section 4, point 5 |
| 157-168 `main()` | `const transport = new StdioServerTransport(); await server.connect(transport);` (165-166) | `serveStdio(buildServer, { onerror: (e) => logger.error("stdio transport error", e) });` | Dual-era stdio entry. `onerror` goes to stderr, never stdout. |
| 170-182 | process handlers | Keep | Unchanged |

#### 5.2.1 Tool annotations

| Tool (line) | `title` | `readOnlyHint` | `destructiveHint` | `idempotentHint` | `openWorldHint` |
|---|---|---|---|---|---|
| `docs_home` (50) | Docs home | true | - | - | false |
| `list_doc_sources` (60) | List doc sources | true | - | - | false |
| `search_docs` (69) | Search docs | true | - | - | true (fetches llms.txt and pages) |
| `fetch_doc` (97) | Fetch doc | true | - | - | true |
| `add_doc_source` (113) | Add doc source | false | false | false (fails on duplicate) | true |
| `remove_doc_source` (133) | Remove doc source | false | true (edits persisted `sources.json`) | true | false |
| `refresh_doc_source` (142) | Refresh doc source | false | false | true | true |

Keep the seven registrations in their current order. That order is the deterministic `tools/list` order the spec asks for.

#### 5.2.2 Proposed shape of `src/index.ts`

```ts
#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
// ...existing imports from ./config.js, ./tools/docs.js, ./utils/*...

const ONE_HOUR = 3_600_000;

function json(data: unknown, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }], isError };
}

function buildServer(): McpServer {
  const server = new McpServer(
    { name: APP_NAME, version: APP_VERSION },
    {
      instructions: "...unchanged...",
      // Static tool set: no list-change notifications; let clients cache the list.
      capabilities: { tools: { listChanged: false } },
      cacheHints: {
        "tools/list": { ttlMs: ONE_HOUR, cacheScope: "public" },
        "server/discover": { ttlMs: ONE_HOUR, cacheScope: "public" },
      },
    }
  );

  server.registerTool(
    "search_docs",
    {
      title: "Search docs",
      description: "...unchanged...",
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: z.object({
        query: z.string().describe("..."),
        source: z.string().optional().describe("..."),
        k: z.number().int().min(1).max(50).optional().default(5).describe("..."),
      }),
    },
    async ({ query, source, k }) => {
      try {
        return json(await searchDocs(query, source, k ?? 5));
      } catch (e) {
        logger.error("search_docs failed", e);
        return json({ error: "search failed", message: String(e) }, true);
      }
    }
  );
  // ...other six tools, same order, same handlers...

  return server;
}

async function main(): Promise<void> {
  logger.info(`Starting ${APP_NAME} v${APP_VERSION}`);
  // ...registry warm-up unchanged...
  serveStdio(buildServer, { onerror: (e) => logger.error("stdio transport error", e) });
  logger.info("Server running on stdio (MCP 2026-07-28 + legacy)");
}
```

`buildServer` is cheap: it only registers closures. All state (registry, indexes, page cache) lives in module-level singletons in `src/utils/*`, so every pinned instance shares one index.

### 5.3 `src/tools/docs.ts`: optional (typed output)

No change is required. To adopt `outputSchema`:

- `:23-29` `SearchHit`: mirror it as a zod schema. Use it in `search_docs`'s `outputSchema` as `{ scope, count, hint, results: SearchHit[] }` (return type at `:77`).
- `:60-62` `listDocSources()`: `outputSchema` `{ sources: SourceSummary[] }`. Verified working in the spike: the response carried `structuredContent` alongside `content`.
- `:125-142` `fetchDoc()`: the `error` field (`:134`, `:140`) mixes success and failure in one shape. When using `outputSchema`, return `isError: true` with a text block on failure and **omit** `structuredContent`. Clients validate `structuredContent` against the schema, so an error object must not be sent through it.
- `docsHome()` (`:42-58`): leave it untyped. It's prose for the model.

Recommendation: do this in a follow-up PR so the protocol migration stays small (see the AutoSDE/CR-size note in room memory).

### 5.4 `src/config.ts`: small

| Line | Current | Change | Why |
|---|---|---|---|
| 8 | `APP_VERSION = "0.1.0"` hard-coded | Bump with the release, or read from `package.json` | It's now sent on **every** modern response (`_meta["io.modelcontextprotocol/serverInfo"]`, verified). A stale value misreports the version on every call. |

### 5.5 `src/utils/logger.ts`: no change

Lines 2 and 40 (`console.error`) already follow the spec's migration path for the deprecated Logging feature: "log to `stderr` for stdio transports". Don't adopt `ctx.mcpReq.log()`. It's `@deprecated`, and on 2026 requests it emits nothing unless the client sends `io.modelcontextprotocol/logLevel`.

### 5.6 Tests: required addition

The current suite (`test/*.test.ts`, 49 tests) never touches the MCP layer. `test/server.test.ts` covers the registry, URL validator, and BM25 only. Add `test/protocol.test.ts`:

- Spawn `dist/index.js` (or `tsx src/index.ts`) with `StdioClientTransport` from `@modelcontextprotocol/client/stdio`, with `LLMSTXT_REGISTRY_PATH` pointed at a temp file.
- Case **modern**: `new Client(info, { versionNegotiation: { mode: { pin: "2026-07-28" } } })`. Assert `getProtocolEra() === "modern"`, all 7 tool names in order, and that `list_doc_sources` succeeds.
- Case **legacy**: the default `Client` (initialize handshake) still works. This protects existing users.
- Case **auto**: negotiates `modern`.
- Case **errors**: an unknown tool rejects with `-32602`, and `search_docs` with `k: 500` returns `isError: true`.
- Optional raw-wire case: write one enveloped `tools/list` line and assert `resultType === "complete"`, `ttlMs === 3600000`, `cacheScope === "public"`.
- Use only `list_doc_sources` and `docs_home` so the tests stay offline, matching the `npm test` "offline unit tests" contract (`README.md:138`).

`test/deps.test.ts:13-33` (nothing written to stdout on import) stays valid and still matters: stdout is the protocol channel in both eras.

### 5.7 `server.json`: update at release

| Line | Change | Why |
|---|---|---|
| 9, 14 | Bump `version` to match `package.json` | Registry versioning |
| 2 | `$schema` `2025-12-11` | Keep. That's the registry's `server.json` schema version, not the MCP protocol version; the live registry entry uses it. |

### 5.8 `README.md`: docs

| Line/section | Change |
|---|---|
| Header or Installation (`:28`) | State "Implements MCP 2026-07-28 (stateless) and remains compatible with 2025-era clients" and "Requires Node.js 20+" |
| `## Tools` (`:81-91`) | Add an annotations column or note (read-only vs mutating tools) |
| `## Testing with MCP Inspector` (`:116-122`) | Mention the Inspector handles both protocol eras ([Protocol eras](https://modelcontextprotocol.io/docs/2026-07-28/tools/inspector/protocol-eras.md)) |
| `## Architecture` (`:174-193`) | `index.ts`: "tool registration + `serveStdio` dual-era entry" |
| `## Development` (`:124`) | Engines note: Node 20 |

### 5.9 `tsconfig.json`: no change

TypeScript is `^5.7`. The v2 note about adding `"types": ["node"]` applies only to TypeScript ≥6. `module: NodeNext` already resolves the package's `./stdio` subpath export (verified: `tsc --noEmit` passed in the spike).

## 6. Step-by-step procedure

1. Branch: `feat/mcp-2026-07-28`.
2. `npx @modelcontextprotocol/codemod@2.2.0 v1-to-v2 .` from the package root. This rewrites the imports and wraps the raw shapes in `z.object` at `src/index.ts:55,64,78,103,118,137,146`, and swaps the dependency in `package.json`. The spike output: "Changes: 9 across 1 file(s)".
3. Fix what the codemod doesn't: `zod` → `^4.2.0`, `engines.node` → `>=20`, `StdioServerTransport` + `connect` → `serveStdio(buildServer)`, and the `buildServer` factory wrapper.
4. Add `capabilities.tools.listChanged: false`, `cacheHints`, `title`, and `annotations`.
5. `npm install && npm run typecheck && npm test && npm run build`.
6. Add `test/protocol.test.ts` (5.6) and `@modelcontextprotocol/client` as a dev dependency.
7. Smoke test with the Inspector: `npm run inspect:dev`, once in legacy and once in modern mode.
8. Update the README, bump the version in `package.json`, `src/config.ts:8`, and `server.json`, then publish and update the registry entry.

## 7. Things that stay as they are, and why

### 7.1 Runtime source registry vs "stateless MCP"

`add_doc_source`/`remove_doc_source` mutate process-wide state persisted to `~/.config/llmstxt-doc-search/sources.json` (`src/utils/registry.ts`). That's allowed. The 2026 statelessness rule is about protocol sessions and per-connection variation of list results. `tools/list` never changes with the registry (sources are tool data, not tools). On stdio there is one client per process, so there's no cross-tenant leakage. If a Streamable HTTP transport is ever added, this becomes shared multi-user state and would need auth and per-principal registries. That's out of scope.

### 7.2 SSRF guard, fetcher, BM25 index, page cache

`src/utils/url-validator.ts`, `doc-fetcher.ts`, `indexer.ts`, `store.ts`, and `registry.ts` have no SDK coupling (grep shows no SDK imports). The spec's tool security MUSTs (validate inputs, sanitize outputs) are unaffected, and zod still validates inputs.

### 7.3 `docs_home` as the entry point

Under 2026, `instructions` reach only clients that call `server/discover` (or legacy `initialize`), and discovery is optional for modern clients. `docs_home` duplicates the orientation as a tool, so it keeps working for clients that skip discovery. Keep it first in registration order.

### 7.4 No HTTP transport

Streamable HTTP (`createMcpHandler`) isn't needed for the `npx` use case, and adding it brings auth, `Mcp-Param-*` headers, and Origin validation into scope. Treat it as a separate feature.

## 8. Risks and breaking changes

| Risk | Impact | Mitigation |
|---|---|---|
| Node 18 users | Install warning or runtime failure | Node 18 is past EOL. Document "Node 20+" and bump the minor version (0.x semver allows breaking changes in a minor). |
| zod 3 → 4 | Type-level API changes | Only `src/index.ts` uses zod. The spike type-checked unchanged apart from the `z.object` wrapping. |
| Wire shape of `inputSchema` changes (2020-12 `$schema`, no `additionalProperties: false` by default) | Strict clients or golden tests pinned to old shapes | None exist in this repo. The new shapes conform to the spec. |
| Unknown tool now rejects instead of returning `isError` | Clients that relied on `isError` for unknown tools | Spec-mandated. No first-party callers. |
| `serveStdio` advertises only `["2026-07-28"]` in `discover.supportedVersions` (observed) while still serving legacy `initialize` | None for clients (the era is chosen by how the client opens) | Covered by the legacy test case |
| `listChanged: false` | If dynamic tools are added later, clients won't be notified | Flip it to `true` at that point and publish via `sendToolListChanged()`. `serveStdio` routes it onto `subscriptions/listen`. |
| `ttlMs` of 1 h on `tools/list` | After an upgrade, a client may use the old tool list for up to 1 h | Tools only change with a package upgrade, which restarts the process and the client connection. Lower it to 5 min if that's a concern. |
| v1 SDK support window | v1 `1.x` still gets releases (1.31.0 on 2026-09-28) | Not a blocker, but v1 will never serve 2026-07-28 |

## 9. Verification done for this report

In a throwaway copy of the repo (`/tmp/spike`, since deleted), not in the working tree:

- The codemod ran cleanly: "Changes: 9 across 1 file(s)", plus the zod-floor warning.
- With `zod ^4.2.0`, `serveStdio(buildServer)`, `cacheHints`, `listChanged: false`, and one tool annotation: `tsc --noEmit` passes, `npm test` passes (7 files, 49 tests), and `npm run build` passes.
- Protocol probe with `@modelcontextprotocol/client@2.2.0` over stdio:

  ```text
  legacy { listResultOk: true, ann: '{"readOnlyHint":true,"openWorldHint":false}' }
  modern { era: 'modern', server: { name: 'llmstxt-doc-search', version: '0.1.0' }, tools: 'docs_home,list_doc_sources,search_docs,fetch_doc,add_doc_source,remove_doc_source,refresh_doc_source', listResultOk: true }
  auto   { era: 'modern', ... }
  ```

- Raw modern `tools/list` with no handshake returned `{resultType: 'complete', ttlMs: 3600000, cacheScope: 'public', _meta: {io.modelcontextprotocol/serverInfo: {...}}}`, and the `inputSchema` had `$schema: https://json-schema.org/draft/2020-12/schema` with `.describe()` text and `default: 5` preserved.
- Error model: `ping` → `-32601` (removed method). Unknown tool → `-32602 "Tool nope not found"`. `k: 500` → `isError: true` with "Input validation error: ... k: Too big: expected number to be <=50". `server/discover` returned `supportedVersions: ["2026-07-28"]`, `capabilities.tools.listChanged: false`, and `instructions`.
- `outputSchema` on `list_doc_sources`: the response carried both `content` and `structuredContent`.
- Baseline: current `main` `dist/index.js` fails a pinned-modern client with `ERA_NEGOTIATION_FAILED` (Section 3).
- Footprint: production `node_modules` goes from 91 packages / 24 MB (v1 SDK + zod 3 + ipaddr.js) to 3 packages / 16 MB (v2 server + zod 4 + ipaddr.js). RSS after `tools/list` is about 87 MB either way.

Not verified: behaviour in specific hosts (Claude Desktop, Kiro) against the modern path; `outputSchema` on `search_docs`/`fetch_doc`; the new `test/protocol.test.ts` (it's specified here, not written).

## 10. Release and versioning

The room notes put `0.2.0` on the stemmer swap, index performance, and the bounded URL cache. Those are already merged (`5f997c5`) but unpublished; `package.json:3` is still `0.1.0`. Options:

- **A (recommended):** publish `0.2.0` as planned, then ship this migration as `0.3.0`. The breaking runtime floor (Node 20, zod 4) and the protocol change are isolated, and each release is easy to bisect and roll back.
- **B:** fold this into `0.2.0`. One release, but it mixes ranking and memory changes with a protocol and SDK major-version change.

## 11. References

- Spec 2026-07-28: [index](https://modelcontextprotocol.io/specification/2026-07-28), [changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog.md), [deprecated](https://modelcontextprotocol.io/specification/2026-07-28/deprecated.md), [versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning.md), [discover](https://modelcontextprotocol.io/specification/2026-07-28/server/discover.md), [caching](https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/caching.md), [tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools.md), [stdio](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md)
- TypeScript SDK v2: [upgrade-to-v2.md](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/upgrade-to-v2.md), [support-2026-07-28.md](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md), `@modelcontextprotocol/server@2.2.0`, `@modelcontextprotocol/codemod@2.2.0`
