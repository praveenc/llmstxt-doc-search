/**
 * Source registry: persisted list of llms.txt indexes, addable at runtime.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { REGISTRY_PATH, DEFAULT_SOURCES } from "../config.js";
import { assertPublicHttpUrl, URLValidationError } from "./url-validator.js";
import { logger } from "./logger.js";

export interface Source {
  /** Short stable id used to scope searches, e.g. "strands". */
  name: string;
  /** The llms.txt index URL. */
  url: string;
  /** Base prefix used to authorize on-demand doc fetches (derived from url). */
  base: string;
  addedAt: string;
}

/** Derive the directory base of an llms.txt URL (used as the fetch allow-prefix). */
export function deriveBase(url: string): string {
  const i = url.lastIndexOf("/");
  return i >= 0 ? url.slice(0, i + 1) : url + "/";
}

function makeSource(name: string, url: string): Source {
  return { name, url, base: deriveBase(url), addedAt: new Date().toISOString() };
}

let cache: Source[] | null = null;

function seedDefaults(): Source[] {
  return DEFAULT_SOURCES.map((s) => makeSource(s.name, s.url));
}

export function loadRegistry(): Source[] {
  if (cache) return cache;
  try {
    if (existsSync(REGISTRY_PATH)) {
      const raw = JSON.parse(readFileSync(REGISTRY_PATH, "utf-8"));
      const list = Array.isArray(raw?.sources) ? raw.sources : [];
      cache = list
        .filter((s: any) => s?.name && s?.url)
        .map((s: any) => ({
          name: String(s.name),
          url: String(s.url),
          base: deriveBase(String(s.url)),
          addedAt: s.addedAt || new Date().toISOString(),
        }));
      if (cache && cache.length) return cache;
    }
  } catch (e) {
    logger.warn(`failed to read registry at ${REGISTRY_PATH}, seeding defaults`, e);
  }
  cache = seedDefaults();
  saveRegistry();
  return cache;
}

export function saveRegistry(): void {
  if (!cache) return;
  try {
    mkdirSync(dirname(REGISTRY_PATH), { recursive: true });
    writeFileSync(REGISTRY_PATH, JSON.stringify({ sources: cache }, null, 2), "utf-8");
  } catch (e) {
    logger.error(`failed to persist registry at ${REGISTRY_PATH}`, e);
  }
}

export function getSources(): Source[] {
  return loadRegistry();
}

export function getSource(name: string): Source | undefined {
  return loadRegistry().find((s) => s.name === name);
}

/** Find the registered source whose base prefix authorizes a doc URL. */
export function findSourceForUrl(url: string): Source | undefined {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return undefined;
  }
  return loadRegistry().find((s) => {
    let baseUrl: URL;
    try {
      baseUrl = new URL(s.base);
    } catch {
      return false;
    }
    // Same origin, and the doc path is at or under the source's base path.
    // Compare on a path boundary so `/foo` does not authorize `/foobar`.
    if (target.protocol !== baseUrl.protocol || target.host !== baseUrl.host) {
      return false;
    }
    const basePath = baseUrl.pathname.endsWith("/")
      ? baseUrl.pathname
      : baseUrl.pathname + "/";
    return target.pathname === baseUrl.pathname || target.pathname.startsWith(basePath);
  });
}

export function addSourceEntry(name: string, url: string): Source {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) {
    throw new URLValidationError(
      `invalid source name '${name}' (use letters, digits, dot, dash, underscore)`
    );
  }
  const normalized = assertPublicHttpUrl(url);
  const list = loadRegistry();
  if (list.some((s) => s.name === name)) {
    throw new URLValidationError(`source '${name}' already exists`);
  }
  const src = makeSource(name, normalized);
  list.push(src);
  cache = list;
  saveRegistry();
  return src;
}

export function removeSourceEntry(name: string): boolean {
  const list = loadRegistry();
  const next = list.filter((s) => s.name !== name);
  if (next.length === list.length) return false;
  cache = next;
  saveRegistry();
  return true;
}

/** Test-only: reset the in-memory cache. */
export function _resetRegistryCache(): void {
  cache = null;
}
