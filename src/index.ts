import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { closeMcps, connectMcp, isDefined } from "./mcp-clients.js";
import { loadMcpConfig } from "./mcp-config.js";
import { publishMcpTools } from "./mcp-tool-discovery.js";
import type { McpConnection } from "./mcp-types.js";

/**
 * Main extension entry point. It manages MCP connections for each session and
 * publishes available tools to pi-dynamic-tools for on-demand activation.
 */
export default function (pi: ExtensionAPI): void {
  let connections: McpConnection[] = [];
  pi.on("session_start", async (_event, ctx) => {
    const mcpConfig = await loadMcpConfig(pi, ctx);
    connections = (
      await Promise.all(
        Object.entries(mcpConfig).map(([name, entry]) => connectMcp(entry, name, ctx.cwd)),
      )
    ).filter(isDefined);
    await publishMcpTools(pi, connections);
  });

  pi.on("session_shutdown", async () => {
    await closeMcps(connections);
    connections = [];
  });

  pi.registerFlag("mcp", {
    description: "Add an mcp configuration JSON config or file path",
    type: "string",
  });
}
