import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { JSONObject, Tool } from "@modelcontextprotocol/client";
import { registerDynamicTool } from "pi-dynamic-tools";

import type { McpConnection } from "./mcp-types.js";

/** Applies the configured allowlist to tools reported by an MCP server. */
export function filterTools(tools: Tool[], toolsFilter: string[] | undefined): Tool[] {
  if (
    !toolsFilter ||
    toolsFilter.length === 0 ||
    (toolsFilter.length === 1 && toolsFilter[0] === "*")
  ) {
    return tools;
  }

  if (!toolsFilter.includes("*")) {
    return tools.filter((tool) => toolsFilter.includes(tool.name));
  }

  const explicitToolNames = toolsFilter.filter((name) => name !== "*");
  const explicitTools = tools.filter((tool) => explicitToolNames.includes(tool.name));
  const explicitToolSet = new Set(explicitTools.map((tool) => tool.name));
  const readOnlyTools = tools.filter((tool) => tool.annotations?.readOnlyHint);

  return [...explicitTools, ...readOnlyTools.filter((tool) => !explicitToolSet.has(tool.name))];
}

/** MCP identifiers may contain characters that pi tool names do not permit. */
function piToolName(server: string, tool: string): string {
  const name = `${server}_${tool}`.replaceAll(/[^a-zA-Z0-9_]/g, "_");

  return /^[a-zA-Z]/.test(name) ? name : `mcp_${name}`;
}

/** Publishes allowed tools from connected servers to the shared search registry. */
export async function publishMcpTools(
  pi: ExtensionAPI,
  connections: McpConnection[],
): Promise<void> {
  await Promise.all(
    connections.map(async (connection) => {
      if (!connection.client.getServerCapabilities()?.tools) return;

      try {
        const response = await connection.client.listTools();

        for (const tool of filterTools(response.tools, connection.entry.tools)) {
          const name = piToolName(connection.name, tool.name);
          registerDynamicTool(pi, {
            name,
            label: tool.name,
            description: tool.description || tool.name,
            parameters: Type.Unsafe<JSONObject>(tool.inputSchema),
            async execute(_toolCallId, args) {
              const result = await connection.client.callTool({ name: tool.name, arguments: args });

              return {
                content: result.content.filter(
                  (content) => content.type === "text" || content.type === "image",
                ),
                details: result._meta ?? {},
              };
            },
          });
        }
      } catch {
        // One unavailable server must not prevent other servers from publishing tools.
      }
    }),
  );
}
