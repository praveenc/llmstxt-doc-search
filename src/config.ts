/**
 * Configuration for llmstxt-doc-search.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const APP_NAME = "llmstxt-doc-search";

/**
 * Read from package.json (one level above both src/ and dist/) so the version
 * reported in serverInfo and the User-Agent cannot drift from the published one.
 */
export const APP_VERSION: string = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;

/** Where the source registry is persisted (override with LLMSTXT_REGISTRY_PATH). */
export const REGISTRY_PATH =
  process.env.LLMSTXT_REGISTRY_PATH ||
  join(homedir(), ".config", "llmstxt-doc-search", "sources.json");

/** Max number of search results hydrated with content for snippets. */
export const SNIPPET_HYDRATE_MAX = Number(process.env.LLMSTXT_SNIPPET_HYDRATE_MAX || 5);

/**
 * Max number of fetched pages kept in memory per source, evicted least-recently
 * used. Bounds the page cache in long sessions. Set to 0 to disable the cap.
 */
export const PAGE_CACHE_MAX = (() => {
  const raw = process.env.LLMSTXT_PAGE_CACHE_MAX;
  if (raw === undefined || raw.trim() === "") return 50;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 50;
})();

/**
 * How long a source whose llms.txt failed to index is skipped before it is
 * retried, so a broken source does not slow every search. refresh_doc_source
 * retries immediately.
 */
export const INDEX_RETRY_BACKOFF_MS = 5 * 60 * 1000;

/** Seed sources written to the registry on first run. */
export const DEFAULT_SOURCES: { name: string; url: string }[] = [
  { name: "strands", url: "https://strandsagents.com/llms.txt" },
  { name: "kiro", url: "https://kiro.dev/llms.txt" },
  {
    name: "aws-bedrock-userguide",
    url: "https://docs.aws.amazon.com/bedrock/latest/userguide/llms.txt",
  },
  {
    name: "aws-agentic-ai-lens",
    url: "https://docs.aws.amazon.com/wellarchitected/latest/agentic-ai-lens/llms.txt",
  },
  {
    name: "aws-bedrock-agentcore-devguide",
    url: "https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/llms.txt",
  },
  { name: "mcp", url: "https://modelcontextprotocol.io/llms.txt" },
];
