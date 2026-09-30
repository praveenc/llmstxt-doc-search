import { describe, it, expect, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

// Drives the real server over stdio in every protocol era. Only tools that
// never touch the network (docs_home, list_doc_sources, and a search_docs call
// rejected by input validation) are called, so the suite stays offline.

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TSX = join(ROOT, "node_modules", ".bin", "tsx");
const ENTRY = join(ROOT, "src", "index.ts");
const TMP_DIR = mkdtempSync(join(tmpdir(), "llmstxt-protocol-"));
const ENV = {
  ...(process.env as Record<string, string>),
  LLMSTXT_REGISTRY_PATH: join(TMP_DIR, "sources.json"),
  LLMSTXT_LOG_LEVEL: "error",
};
const MODERN = "2026-07-28";
const TOOL_ORDER = [
  "docs_home",
  "list_doc_sources",
  "search_docs",
  "fetch_doc",
  "add_doc_source",
  "remove_doc_source",
  "refresh_doc_source",
];
const TIMEOUT = 30_000;

type Mode = "legacy" | "auto" | { pin: string };

async function connect(mode: Mode): Promise<Client> {
  const transport = new StdioClientTransport({
    command: TSX,
    args: [ENTRY],
    env: ENV,
    stderr: "ignore",
  });
  const client = new Client(
    { name: "protocol-test", version: "1.0.0" },
    { versionNegotiation: { mode } }
  );
  await client.connect(transport);
  return client;
}

async function withClient<T>(mode: Mode, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = await connect(mode);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

afterAll(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

describe.each([
  ["legacy (initialize handshake)", "legacy" as Mode, "legacy"],
  ["auto negotiation", "auto" as Mode, "modern"],
  [`pinned ${MODERN}`, { pin: MODERN } as Mode, "modern"],
])("MCP over stdio: %s", (_label, mode, era) => {
  it(
    "connects in the expected era and lists all tools in registration order",
    () =>
      withClient(mode, async (c) => {
        expect(c.getProtocolEra()).toBe(era);
        expect(c.getServerVersion()?.name).toBe("llmstxt-doc-search");
        const { tools } = await c.listTools();
        expect(tools.map((t) => t.name)).toEqual(TOOL_ORDER);
      }),
    TIMEOUT
  );

  it(
    "calls an offline tool successfully",
    () =>
      withClient(mode, async (c) => {
        const res = await c.callTool({ name: "list_doc_sources", arguments: {} });
        expect(res.isError).toBeFalsy();
        const text = (res.content as { type: string; text: string }[])[0].text;
        expect(JSON.parse(text).sources.length).toBeGreaterThan(0);
      }),
    TIMEOUT
  );

  it(
    "rejects an unknown tool with -32602 and bad arguments with an isError result",
    () =>
      withClient(mode, async (c) => {
        await expect(c.callTool({ name: "no_such_tool", arguments: {} })).rejects.toMatchObject({
          code: -32602,
        });
        const bad = await c.callTool({ name: "search_docs", arguments: { query: "x", k: 500 } });
        expect(bad.isError).toBe(true);
      }),
    TIMEOUT
  );
});

describe("tool metadata", () => {
  it(
    "marks read-only and destructive tools with annotations and titles",
    () =>
      withClient({ pin: MODERN }, async (c) => {
        const { tools } = await c.listTools();
        const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
        for (const name of ["docs_home", "list_doc_sources", "search_docs", "fetch_doc"]) {
          expect(byName[name].annotations?.readOnlyHint, name).toBe(true);
        }
        for (const name of ["add_doc_source", "remove_doc_source", "refresh_doc_source"]) {
          expect(byName[name].annotations?.readOnlyHint, name).toBe(false);
        }
        expect(byName.remove_doc_source.annotations?.destructiveHint).toBe(true);
        expect(byName.add_doc_source.annotations?.destructiveHint).toBe(false);
        expect(byName.add_doc_source.annotations?.idempotentHint).toBe(false);
        expect(tools.every((t) => typeof t.title === "string" && t.title.length > 0)).toBe(true);
      }),
    TIMEOUT
  );

  it(
    "keeps argument descriptions and defaults in the input schemas",
    () =>
      withClient({ pin: MODERN }, async (c) => {
        const { tools } = await c.listTools();
        const search = tools.find((t) => t.name === "search_docs")!;
        const props = search.inputSchema.properties as Record<string, Record<string, unknown>>;
        expect(search.inputSchema.required).toEqual(["query"]);
        expect(props.k.default).toBe(5);
        expect(props.k.maximum).toBe(50);
        expect(String(props.query.description)).toMatch(/Search query/);
        const home = tools.find((t) => t.name === "docs_home")!;
        expect(home.inputSchema.additionalProperties).toBe(false);
      }),
    TIMEOUT
  );
});

/** Sends raw JSON-RPC lines with no handshake and collects the responses by id. */
function rawExchange(requests: object[]): Promise<Map<number, Record<string, any>>> {
  return new Promise((resolve, reject) => {
    const child = spawn(TSX, [ENTRY], { env: ENV, stdio: ["pipe", "pipe", "ignore"] });
    const responses = new Map<number, Record<string, any>>();
    let buf = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timed out; got ${responses.size}/${requests.length} responses`));
    }, TIMEOUT - 5_000);
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (typeof msg.id === "number") responses.set(msg.id, msg);
      }
      if (responses.size === requests.length) {
        clearTimeout(timer);
        child.kill();
        resolve(responses);
      }
    });
    child.on("error", reject);
    for (const r of requests) child.stdin.write(JSON.stringify(r) + "\n");
  });
}

describe("2026-07-28 wire format", () => {
  const meta = {
    "io.modelcontextprotocol/protocolVersion": MODERN,
    "io.modelcontextprotocol/clientInfo": { name: "raw", version: "1.0.0" },
    "io.modelcontextprotocol/clientCapabilities": {},
  };

  it(
    "answers the first request without a handshake and carries cache hints",
    async () => {
      const res = await rawExchange([
        { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: meta } },
        { jsonrpc: "2.0", id: 2, method: "server/discover", params: { _meta: meta } },
      ]);
      const list = res.get(1)!.result;
      expect(list.resultType).toBe("complete");
      expect(list.ttlMs).toBe(3_600_000);
      expect(list.cacheScope).toBe("public");
      expect(list.tools.map((t: { name: string }) => t.name)).toEqual(TOOL_ORDER);

      const discover = res.get(2)!.result;
      expect(discover.supportedVersions).toContain(MODERN);
      expect(discover.capabilities.tools.listChanged).toBe(false);
      expect(discover.ttlMs).toBe(3_600_000);
      expect(discover.cacheScope).toBe("public");
      expect(discover.instructions).toMatch(/docs_home/);
    },
    TIMEOUT
  );
});
