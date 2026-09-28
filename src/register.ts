import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { McpEntry } from "./mcp-types.js";
import { loadPluginMcp } from "./plugin-mcp.js";

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

/** Register the MCP components of an Agent Plugins v1 package through the event bus.
 * The caller owns installation and supplies a stable per-installation data directory.
 */
export async function registerMcpPlugin(
  pi: Pick<ExtensionAPI, "events">,
  pluginRoot: string,
  pluginData: string,
): Promise<void> {
  const servers = await loadPluginMcp(pluginRoot, pluginData);

  for (const [name, entry] of servers) registerMcpServer(pi, name, entry);
}

export type { McpEntry } from "./mcp-types.js";
