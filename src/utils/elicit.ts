/**
 * Capability gating for form-mode elicitation.
 *
 * A server may only send `elicitation/create` when the client declared form
 * elicitation. The declaration lives in the per-request `_meta` envelope on
 * the 2026-07-28 era and in the `initialize`-declared capabilities on a
 * 2025-era connection, so both are consulted.
 */
import { CLIENT_CAPABILITIES_META_KEY } from "@modelcontextprotocol/server";
import type { ServerContext, ClientCapabilities } from "@modelcontextprotocol/server";

type ElicitationCapability = { form?: unknown; url?: unknown } | undefined;

/**
 * Whether the client declared form-mode elicitation. A bare `elicitation: {}`
 * counts as form (backwards compatibility); `{ url: {} }` alone does not.
 */
export function supportsFormElicitation(
  ctx: ServerContext,
  legacyCaps: ClientCapabilities | undefined
): boolean {
  const envCaps = (ctx.mcpReq.envelope as Record<string, unknown> | undefined)?.[
    CLIENT_CAPABILITIES_META_KEY
  ] as ClientCapabilities | undefined;
  const e = (envCaps ?? legacyCaps)?.elicitation as ElicitationCapability;
  if (!e) return false;
  const hasForm = e.form !== undefined;
  const hasUrl = e.url !== undefined;
  return hasForm || (!hasForm && !hasUrl);
}

/** A single-boolean confirmation form schema for the elicitation request. */
export function confirmSchema(title: string, description: string) {
  return {
    type: "object" as const,
    properties: {
      confirm: { type: "boolean" as const, title, description },
    },
    required: ["confirm"],
  };
}
