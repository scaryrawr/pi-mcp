import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { McpEntry } from "./mcp-types.js";

/** Shared event-bus channel for adding MCP servers to pi-mcp. */
export const REGISTER_MCP_SERVER = "pi-mcp:register";

export const COLLECT_MCP_SERVERS = "pi-mcp:collect";

/** A server registration sent by another pi extension. */
export interface McpServerRegistration {
  name: string;
  entry: McpEntry;
}

/** Offer a server to pi-mcp, before or after session start. */
export function registerMcpServer(
  pi: Pick<ExtensionAPI, "events">,
  name: string,
  entry: McpEntry,
): void {
  const publish = () =>
    pi.events.emit(REGISTER_MCP_SERVER, { name, entry } satisfies McpServerRegistration);

  pi.events.on(COLLECT_MCP_SERVERS, publish);
  publish();
}

export type { McpEntry } from "./mcp-types.js";
