import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

// Drives the real server over stdio in both eras for the destructive
// remove_doc_source confirmation flow. remove_doc_source never touches the
// network, so the suite stays offline. A per-test registry file is seeded so
// there is a known source to remove.

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TSX = join(ROOT, "node_modules", ".bin", "tsx");
const ENTRY = join(ROOT, "src", "index.ts");
const TMP_DIR = mkdtempSync(join(tmpdir(), "llmstxt-elicit-stdio-"));
const TIMEOUT = 30_000;

type Mode = "legacy" | "auto";

function seedRegistry(file: string, name: string): void {
  writeFileSync(
    file,
    JSON.stringify({ sources: [{ name, url: "https://docs.example.com/llms.txt", addedAt: new Date().toISOString() }] }),
    "utf-8"
  );
}

async function withClient(
  registryFile: string,
  mode: Mode,
  action: "accept" | "decline",
  fn: (c: Client) => Promise<void>
): Promise<void> {
  const transport = new StdioClientTransport({
    command: TSX,
    args: [ENTRY],
    env: {
      ...(process.env as Record<string, string>),
      LLMSTXT_REGISTRY_PATH: registryFile,
      LLMSTXT_LOG_LEVEL: "error",
    },
    stderr: "ignore",
  });
  const client = new Client(
    { name: "elicit-stdio", version: "1.0.0" },
    { capabilities: { elicitation: {} }, versionNegotiation: { mode } }
  );
  client.setRequestHandler("elicitation/create", async () =>
    action === "accept" ? { action, content: { confirm: true } } : { action }
  );
  await client.connect(transport);
  try {
    await fn(client);
  } finally {
    await client.close();
  }
}

function parse(res: { content: unknown }): Record<string, unknown> {
  return JSON.parse((res.content as { text: string }[])[0].text);
}

afterAll(() => rmSync(TMP_DIR, { recursive: true, force: true }));

describe.each([
  ["legacy", "legacy" as Mode, "legacy"],
  ["auto negotiation", "auto" as Mode, "modern"],
])("remove_doc_source elicitation over stdio: %s", (label, mode, era) => {
  it(
    "accept removes the source",
    async () => {
      const file = join(TMP_DIR, `accept-${label.replace(/\s/g, "-")}.json`);
      seedRegistry(file, "doomed");
      await withClient(file, mode, "accept", async (c) => {
        expect(c.getProtocolEra()).toBe(era);
        const res = parse(await c.callTool({ name: "remove_doc_source", arguments: { name: "doomed" } }));
        expect(res).toMatchObject({ removed: true, name: "doomed" });
        const list = parse(await c.callTool({ name: "list_doc_sources", arguments: {} }));
        expect((list.sources as { name: string }[]).some((s) => s.name === "doomed")).toBe(false);
      });
    },
    TIMEOUT
  );

  it(
    "decline keeps the source",
    async () => {
      const file = join(TMP_DIR, `decline-${label.replace(/\s/g, "-")}.json`);
      seedRegistry(file, "safe");
      await withClient(file, mode, "decline", async (c) => {
        expect(c.getProtocolEra()).toBe(era);
        const res = parse(await c.callTool({ name: "remove_doc_source", arguments: { name: "safe" } }));
        expect(res).toMatchObject({ removed: false, name: "safe", reason: "declined" });
        const list = parse(await c.callTool({ name: "list_doc_sources", arguments: {} }));
        expect((list.sources as { name: string }[]).some((s) => s.name === "safe")).toBe(true);
      });
    },
    TIMEOUT
  );
});
