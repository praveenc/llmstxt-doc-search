/**
 * Serves the repo-root skills/ folder over MCP (Skills extension, SEP-2640).
 */
import { fileURLToPath } from "node:url";
import type { CacheHint } from "@modelcontextprotocol/server";
import type { SkillCatalog } from "@modelcontextprotocol/server/ext/skills";
import { loadSkills } from "@modelcontextprotocol/server/ext/skills/node";
import { logger } from "./utils/logger.js";

/** One level above both src/ and dist/, so dev and the npm package serve the same folder. */
export const SKILLS_DIR = fileURLToPath(new URL("../skills/", import.meta.url));

/**
 * Loads the skill catalog, or returns undefined (with a warning) when the folder
 * cannot be read, so the tools keep serving. Invalid skills are skipped with a warning.
 */
export async function loadSkillCatalog(
  dir: string,
  cacheHint: CacheHint
): Promise<SkillCatalog | undefined> {
  try {
    return await loadSkills(dir, {
      cacheHint,
      onWarning: (w) => logger.warn(`skill warning: ${w.path}: ${w.message}`),
    });
  } catch (e) {
    logger.warn(`skills not served (${dir})`, e);
    return undefined;
  }
}
