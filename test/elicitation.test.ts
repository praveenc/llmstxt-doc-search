import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

// Per-file registry, set before config.ts reads it.
const TMP = await vi.hoisted(async () => {
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const path = join(tmpdir(), `llmstxt-test-elicit-${process.pid}.json`);
  process.env.LLMSTXT_REGISTRY_PATH = path;
  return path;
});

const mocks = vi.hoisted(() => ({
  parseLlmsTxt: vi.fn(),
  fetchAndClean: vi.fn(),
}));

vi.mock("../src/utils/doc-fetcher.js", () => ({
  parseLlmsTxt: mocks.parseLlmsTxt,
  fetchAndClean: mocks.fetchAndClean,
}));

import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { rmSync } from "node:fs";
import { buildServer } from "../src/index.js";
import { addSourceEntry, getSource, getSources, _resetRegistryCache } from "../src/utils/registry.js";
import { dropSourceState } from "../src/utils/store.js";

type ElicitAction = "accept" | "decline" | "cancel";
type ClientCaps = Record<string, unknown>;

const LLMS = "https://docs.example.com/llms.txt";

function seedStubs() {
  mocks.parseLlmsTxt.mockImplementation(async (url: string) => {
    if (url === LLMS) return [["A", "https://docs.example.com/a.md"]];
    throw new Error(`unreachable: ${url}`);
  });
  mocks.fetchAndClean.mockImplementation(async (url: string) => ({ url, title: "t", content: "body" }));
}

/**
 * Connect a real client to a fresh in-process server, declaring `caps` and
 * answering any elicitation with `action` (and `confirm` content on accept).
 * `era` picks the 2025 handshake (legacy) or the 2026-07-28 wire (auto).
 */
async function withClient(
  opts: { caps?: ClientCaps; action?: ElicitAction; confirmValue?: boolean; era?: "legacy" | "auto" },
  fn: (c: Client) => Promise<void>
): Promise<void> {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const server = buildServer();
  await server.connect(serverT);

  const client = new Client(
    { name: "elicit-test", version: "1.0.0" },
    { capabilities: opts.caps ?? {}, versionNegotiation: { mode: opts.era ?? "legacy" } }
  );
  if (opts.caps?.elicitation) {
    client.setRequestHandler("elicitation/create", async () => {
      const action = opts.action ?? "accept";
      if (action === "accept") {
        return { action, content: { confirm: opts.confirmValue ?? true } };
      }
      return { action };
    });
  }
  await client.connect(clientT);
  try {
    await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

function result(res: { content: unknown }): Record<string, unknown> {
  const text = (res.content as { type: string; text: string }[])[0].text;
  return JSON.parse(text);
}

const FORM_CAPS: ClientCaps = { elicitation: {} };
const URL_ONLY_CAPS: ClientCaps = { elicitation: { url: {} } };

beforeEach(() => {
  rmSync(TMP, { force: true });
  _resetRegistryCache();
  for (const s of getSources()) dropSourceState(s.name);
  mocks.parseLlmsTxt.mockReset();
  mocks.fetchAndClean.mockReset();
  seedStubs();
});

afterAll(() => {
  rmSync(TMP, { force: true });
});

describe("remove_doc_source with form elicitation (in-memory, legacy era)", () => {
  it("accept removes the source", async () => {
    addSourceEntry("to-remove", LLMS);
    await withClient({ caps: FORM_CAPS, action: "accept", era: "legacy" }, async (c) => {
      const res = result(await c.callTool({ name: "remove_doc_source", arguments: { name: "to-remove" } }));
      expect(res).toMatchObject({ removed: true, name: "to-remove" });
    });
    expect(getSource("to-remove")).toBeUndefined();
  });

  it("decline keeps the source and returns reason", async () => {
    addSourceEntry("keep", LLMS);
    await withClient({ caps: FORM_CAPS, action: "decline", era: "legacy" }, async (c) => {
      const res = result(await c.callTool({ name: "remove_doc_source", arguments: { name: "keep" } }));
      expect(res).toMatchObject({ removed: false, name: "keep", reason: "declined" });
    });
    expect(getSource("keep")).toBeDefined();
  });

  it("cancel keeps the source and returns reason cancelled", async () => {
    addSourceEntry("keep", LLMS);
    await withClient({ caps: FORM_CAPS, action: "cancel", era: "legacy" }, async (c) => {
      const res = result(await c.callTool({ name: "remove_doc_source", arguments: { name: "keep" } }));
      expect(res).toMatchObject({ removed: false, name: "keep", reason: "cancelled" });
    });
    expect(getSource("keep")).toBeDefined();
  });

  it("asks the human even when confirm:true is passed, and respects a false form field", async () => {
    addSourceEntry("keep", LLMS);
    await withClient({ caps: FORM_CAPS, action: "accept", confirmValue: false, era: "legacy" }, async (c) => {
      const res = result(await c.callTool({ name: "remove_doc_source", arguments: { name: "keep", confirm: true } }));
      expect(res).toMatchObject({ removed: false, name: "keep" });
    });
    expect(getSource("keep")).toBeDefined();
  });

  it("cancel with confirm:true removes (headless hosts answer every prompt with cancel)", async () => {
    addSourceEntry("headless", LLMS);
    await withClient({ caps: FORM_CAPS, action: "cancel", era: "legacy" }, async (c) => {
      const res = result(
        await c.callTool({ name: "remove_doc_source", arguments: { name: "headless", confirm: true } })
      );
      expect(res).toMatchObject({ removed: true, name: "headless" });
    });
    expect(getSource("headless")).toBeUndefined();
  });

  it("decline with confirm:true keeps the source", async () => {
    addSourceEntry("keep", LLMS);
    await withClient({ caps: FORM_CAPS, action: "decline", era: "legacy" }, async (c) => {
      const res = result(await c.callTool({ name: "remove_doc_source", arguments: { name: "keep", confirm: true } }));
      expect(res).toMatchObject({ removed: false, name: "keep", reason: "declined" });
    });
    expect(getSource("keep")).toBeDefined();
  });
});

describe("remove_doc_source without form elicitation", () => {
  it("does not remove without confirm, asks for confirmation", async () => {
    addSourceEntry("keep", LLMS);
    await withClient({ caps: URL_ONLY_CAPS, era: "legacy" }, async (c) => {
      const res = result(await c.callTool({ name: "remove_doc_source", arguments: { name: "keep" } }));
      expect(res).toMatchObject({ removed: false, name: "keep", confirmation_required: true });
      expect(String(res.message)).toMatch(/confirm:true/);
    });
    expect(getSource("keep")).toBeDefined();
  });

  it("removes with confirm:true", async () => {
    addSourceEntry("to-remove", LLMS);
    await withClient({ caps: URL_ONLY_CAPS, era: "legacy" }, async (c) => {
      const res = result(await c.callTool({ name: "remove_doc_source", arguments: { name: "to-remove", confirm: true } }));
      expect(res).toMatchObject({ removed: true, name: "to-remove" });
    });
    expect(getSource("to-remove")).toBeUndefined();
  });

  it("an unknown name returns removed:false with no prompt", async () => {
    await withClient({ caps: FORM_CAPS, era: "legacy" }, async (c) => {
      const res = result(await c.callTool({ name: "remove_doc_source", arguments: { name: "nope" } }));
      expect(res).toEqual({ removed: false, name: "nope" });
    });
  });
});

describe("add_doc_source with form elicitation", () => {
  it("decline persists nothing", async () => {
    await withClient({ caps: FORM_CAPS, action: "decline", era: "legacy" }, async (c) => {
      const res = result(
        await c.callTool({ name: "add_doc_source", arguments: { name: "new", llms_txt_url: LLMS } })
      );
      expect(res).toMatchObject({ added: false, name: "new", reason: "declined" });
    });
    expect(getSource("new")).toBeUndefined();
    expect(mocks.parseLlmsTxt).not.toHaveBeenCalled();
  });

  it("accept adds and indexes the source", async () => {
    await withClient({ caps: FORM_CAPS, action: "accept", era: "legacy" }, async (c) => {
      const res = result(
        await c.callTool({ name: "add_doc_source", arguments: { name: "new", llms_txt_url: LLMS } })
      );
      expect(res).toMatchObject({ docCount: 1 });
    });
    expect(getSource("new")).toBeDefined();
  });

  it("cancel without confirm persists nothing; cancel with confirm:true adds", async () => {
    await withClient({ caps: FORM_CAPS, action: "cancel", era: "legacy" }, async (c) => {
      const res = result(
        await c.callTool({ name: "add_doc_source", arguments: { name: "new", llms_txt_url: LLMS } })
      );
      expect(res).toMatchObject({ added: false, name: "new", reason: "cancelled" });
    });
    expect(getSource("new")).toBeUndefined();
    await withClient({ caps: FORM_CAPS, action: "cancel", era: "legacy" }, async (c) => {
      const res = result(
        await c.callTool({ name: "add_doc_source", arguments: { name: "new", llms_txt_url: LLMS, confirm: true } })
      );
      expect(res).toMatchObject({ docCount: 1 });
    });
    expect(getSource("new")).toBeDefined();
  });

  it("decline with confirm:true persists nothing", async () => {
    await withClient({ caps: FORM_CAPS, action: "decline", era: "legacy" }, async (c) => {
      const res = result(
        await c.callTool({ name: "add_doc_source", arguments: { name: "new", llms_txt_url: LLMS, confirm: true } })
      );
      expect(res).toMatchObject({ added: false, name: "new", reason: "declined" });
    });
    expect(getSource("new")).toBeUndefined();
  });

  it("rejects a duplicate before prompting", async () => {
    addSourceEntry("dup", LLMS);
    await withClient({ caps: FORM_CAPS, action: "accept", era: "legacy" }, async (c) => {
      const res = result(
        await c.callTool({ name: "add_doc_source", arguments: { name: "dup2", llms_txt_url: LLMS } })
      );
      expect(res.error).toBe("add failed");
      expect(String(res.message)).toMatch(/already registered/);
    });
  });
});

describe("add_doc_source without form elicitation (unchanged)", () => {
  it("adds directly without a new field", async () => {
    await withClient({ caps: URL_ONLY_CAPS, era: "legacy" }, async (c) => {
      const res = result(
        await c.callTool({ name: "add_doc_source", arguments: { name: "new", llms_txt_url: LLMS } })
      );
      expect(res).toMatchObject({ docCount: 1 });
    });
    expect(getSource("new")).toBeDefined();
  });
});
