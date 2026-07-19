import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { closeMcps, connectMcp, isDefined } from "./mcp-clients.js";
import { loadMcpConfig } from "./mcp-config.js";
import { registerMcpSearchTool } from "./mcp-tool-discovery.js";
import type { McpConnection } from "./mcp-types.js";

/**
 * Main extension entry point. It manages MCP connections for each session and
 * delegates lazy tool search and registration to the discovery module.
 */
export default function (pi: ExtensionAPI): void {
  let connections: McpConnection[] = [];
  const registeredToolNames = new Set<string>();

  registerMcpSearchTool(pi, () => connections, registeredToolNames);

  pi.on("session_start", async (_event, ctx) => {
    registeredToolNames.clear();
    const mcpConfig = await loadMcpConfig(pi, ctx);
    connections = (
      await Promise.all(
        Object.entries(mcpConfig).map(([name, entry]) => connectMcp(entry, name, ctx.cwd)),
      )
    ).filter(isDefined);
  });

  pi.on("session_shutdown", async () => {
    pi.setActiveTools(pi.getActiveTools().filter((name) => !registeredToolNames.has(name)));
    await closeMcps(connections);
    connections = [];
    registeredToolNames.clear();
  });

  pi.registerFlag("mcp", {
    description: "Add an mcp configuration JSON config or file path",
    type: "string",
  });
}
