/**
 * Configuration for llmstxt-doc-search.
 */
import { homedir } from "node:os";
import { join } from "node:path";

export const APP_NAME = "llmstxt-doc-search";
export const APP_VERSION = "0.1.0";

/** Where the source registry is persisted (override with LLMSTXT_REGISTRY_PATH). */
export const REGISTRY_PATH =
  process.env.LLMSTXT_REGISTRY_PATH ||
  join(homedir(), ".config", "llmstxt-doc-search", "sources.json");

/** Max number of search results hydrated with content for snippets. */
export const SNIPPET_HYDRATE_MAX = Number(process.env.LLMSTXT_SNIPPET_HYDRATE_MAX || 5);

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
