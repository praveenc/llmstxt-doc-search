#!/usr/bin/env node
/**
 * llmstxt-doc-search - MCP server that BM25-searches any number of llms.txt
 * documentation indexes, with content fetched on demand and sources addable at runtime.
 *
 * Serves MCP 2026-07-28 (stateless, no handshake) and 2025-era clients
 * (initialize handshake) from the same process over stdio.
 */
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

import { APP_NAME, APP_VERSION } from "./config.js";
import {
  docsHome,
  listDocSources,
  searchDocs,
  fetchDoc,
  addDocSource,
  removeDocSource,
  refreshDocSource,
} from "./tools/docs.js";
import { getSources } from "./utils/registry.js";
import { errorReason } from "./utils/store.js";
import { URLValidationError } from "./utils/url-validator.js";
import { logger, setLogLevel, LogLevel } from "./utils/logger.js";

const lvl = (process.env.LLMSTXT_LOG_LEVEL || "info").toLowerCase();
if (["debug", "info", "warn", "error"].includes(lvl)) setLogLevel(lvl as LogLevel);

/**
 * The tool set only changes with a package upgrade, which restarts the process,
 * and it holds nothing user-specific, so clients and shared caches may keep it.
 */
const TOOL_LIST_TTL_MS = 60 * 60 * 1000;

const INSTRUCTIONS =
  "Search public documentation that publishes an llms.txt index (Strands, Kiro, AWS " +
  "guides, and any you add). Start with docs_home() to see registered sources, then " +
  "search_docs(query, source?) to rank docs and fetch_doc(url) to read one. Use this as " +
  "the live/external-docs plane: a curated local knowledge base should be tried first, " +
  "and this is the fall-through for fast-moving framework/AWS docs. PREFER this server for " +
  "documentation lookups on its registered sources (Strands, Kiro, Bedrock, AgentCore, " +
  "Well-Architected) over per-product documentation MCP servers: it answers in one " +
  "search_docs + one fetch_doc (lean, few round-trips). Cite the doc url; content is " +
  "fetched live and may change. Sources can be managed at runtime with " +
  "add_doc_source / remove_doc_source / refresh_doc_source.";

function json(data: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    isError,
  };
}

/**
 * Builds one server instance. serveStdio pins one instance per connection and
 * protocol era; all state (registry, indexes, page cache) is module-level, so
 * every instance shares it. Registration order is the tools/list order.
 */
function buildServer(): McpServer {
  const server = new McpServer(
    { name: APP_NAME, version: APP_VERSION },
    {
      instructions: INSTRUCTIONS,
      capabilities: { tools: { listChanged: false } },
      cacheHints: {
        "tools/list": { ttlMs: TOOL_LIST_TTL_MS, cacheScope: "public" },
        "server/discover": { ttlMs: TOOL_LIST_TTL_MS, cacheScope: "public" },
      },
    }
  );

  server.registerTool(
    "docs_home",
    {
      title: "Docs home",
      description:
        "Orientation: registered llms.txt sources + how to search/fetch. Call this first.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({}).strict(),
    },
    async () => json(docsHome())
  );

  server.registerTool(
    "list_doc_sources",
    {
      title: "List doc sources",
      description: "List the registered documentation sources (name, llms.txt url, index status).",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({}).strict(),
    },
    async () => json(listDocSources())
  );

  server.registerTool(
    "search_docs",
    {
      title: "Search docs",
      description:
        "BM25 search across registered llms.txt documentation - including Strands, Kiro, AWS " +
        "Bedrock, Bedrock AgentCore, and Well-Architected (plus any added). Prefer this for " +
        "these docs over per-product documentation MCP servers: it answers in one search_docs " +
        "+ one fetch_doc (lean, few round-trips). Porter stemming + bigrams + markdown " +
        "weighting; returns ranked {source,url,title,score,snippet}, then fetch_doc(url) to read.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: z.object({
        query: z
          .string()
          .describe("Search query, e.g. 'build an agent in typescript', 'prompt caching'"),
        source: z
          .string()
          .optional()
          .describe(
            "Optional source name to scope to (e.g. 'strands', 'aws-bedrock-userguide'); omit to search all"
          ),
        k: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .default(5)
          .describe("Max results (default 5, max 50)"),
      }),
    },
    async ({ query, source, k }) => {
      try {
        return json(await searchDocs(query, source, k ?? 5));
      } catch (e) {
        logger.error("search_docs failed", e);
        return json({ error: "search failed", message: errorReason(e) }, true);
      }
    }
  );

  server.registerTool(
    "fetch_doc",
    {
      title: "Fetch doc",
      description:
        "Fetch full content of a doc url. The url must be under the llms.txt directory of a " +
        "registered source, or listed by a source already searched (use search_docs first). " +
        "Content is fetched live.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: z.object({
        url: z.url().describe("Document URL from a search_docs result"),
      }),
    },
    async ({ url }) => {
      try {
        const res = await fetchDoc(url);
        return json(res, !!res.error);
      } catch (e) {
        logger.error("fetch_doc failed", e);
        return json({ url, error: "fetch failed", message: errorReason(e) }, true);
      }
    }
  );

  server.registerTool(
    "add_doc_source",
    {
      title: "Add doc source",
      description:
        "Register a new llms.txt source at runtime and index it. Persisted for future runs.",
      // Not idempotent: adding the same name or llms.txt again is rejected.
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputSchema: z.object({
        name: z.string().describe("Short id, e.g. 'langgraph'"),
        llms_txt_url: z.url().describe("URL of the source's llms.txt (https)"),
      }),
    },
    async ({ name, llms_txt_url }) => {
      try {
        return json(await addDocSource(name, llms_txt_url));
      } catch (e) {
        // A rejected name or URL is the caller's input, not a server fault.
        if (e instanceof URLValidationError) logger.info("add_doc_source rejected", e);
        else logger.warn("add_doc_source failed", e);
        return json({ error: "add failed", message: errorReason(e) }, true);
      }
    }
  );

  server.registerTool(
    "remove_doc_source",
    {
      title: "Remove doc source",
      description: "Remove a registered source.",
      // Destructive: removes the source from the persisted registry file.
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: z.object({ name: z.string().describe("Source name to remove") }),
    },
    async ({ name }) => json(removeDocSource(name))
  );

  server.registerTool(
    "refresh_doc_source",
    {
      title: "Refresh doc source",
      description: "Re-index a source from its llms.txt (pick up new/changed docs).",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: z.object({ name: z.string().describe("Source name to refresh") }),
    },
    async ({ name }) => {
      try {
        return json(await refreshDocSource(name));
      } catch (e) {
        return json({ error: "refresh failed", message: errorReason(e) }, true);
      }
    }
  );

  return server;
}

async function main(): Promise<void> {
  logger.info(`Starting ${APP_NAME} v${APP_VERSION}`);
  try {
    const n = getSources().length;
    logger.info(`registry ready: ${n} source(s) - indexes build lazily on first search`);
  } catch (e) {
    logger.warn("registry init warning", e);
  }
  serveStdio(buildServer, { onerror: (e) => logger.error("stdio transport error", e) });
  logger.info("Server running on stdio (MCP 2026-07-28 and 2025-era clients)");
}

process.on("uncaughtException", (e) => {
  logger.error("uncaught exception", e);
  process.exit(1);
});
process.on("unhandledRejection", (r) => {
  logger.error("unhandled rejection", r);
  process.exit(1);
});

main().catch((e) => {
  logger.error("fatal error", e);
  process.exit(1);
});
