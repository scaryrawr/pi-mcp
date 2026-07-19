import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Tool } from "@modelcontextprotocol/client";

import { getMcpToolMatches } from "./mcp-tool-matching.js";
import type { DiscoveredTool, McpConnection } from "./mcp-types.js";

const MCP_SEARCH_TOOL_NAME = "mcp_search_tools";

/** Applies the configured allowlist to tools reported by an MCP server. */
function filterTools(tools: Tool[], toolsFilter: string[] | undefined): Tool[] {
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

/** Retrieves tools available from all connected MCP servers without registering them. */
async function discoverMcpTools(connections: McpConnection[]): Promise<DiscoveredTool[]> {
  const toolsByConnection = await Promise.all(
    connections.map(async (connection) => {
      if (!connection.client.getServerCapabilities()?.tools) {
        return [];
      }

      const response = await connection.client.listTools();
      return filterTools(response.tools, connection.entry.tools).map((tool) => ({
        connection,
        tool,
      }));
    }),
  );
  return toolsByConnection.flat();
}

/** Registers a discovered MCP tool and returns its pi tool name. */
function registerMcpTool(pi: ExtensionAPI, discoveredTool: DiscoveredTool): string {
  const { connection, tool } = discoveredTool;
  const name = `${connection.name}_${tool.name}`;
  pi.registerTool({
    name,
    label: tool.name,
    description: tool.description || tool.name,
    parameters: Type.Unsafe<Record<string, unknown>>(tool.inputSchema),
    async execute(_toolCallId, args, _signal, _onUpdate, _ctx) {
      const result = await connection.client.callTool({
        name: tool.name,
        arguments: args,
      });
      return {
        content: result.content.filter(
          (content) => content.type === "text" || content.type === "image",
        ),
        details: (result._meta ?? {}) as Record<string, unknown>,
      };
    },
  });
  return name;
}

/**
 * Registers the lazy MCP search tool.
 * @param getConnections - Reads the current session's active MCP connections.
 * @param registeredToolNames - Tracks tools registered by this search tool.
 */
export function registerMcpSearchTool(
  pi: ExtensionAPI,
  getConnections: () => McpConnection[],
  registeredToolNames: Set<string>,
): void {
  pi.registerTool({
    name: MCP_SEARCH_TOOL_NAME,
    label: "Search MCP Tools",
    description: "Find and load MCP tools by server, tool name, or capability.",
    parameters: Type.Object({
      query: Type.String({
        description:
          "Plain-text server, tool, or capability keywords. All words must match; regex is not supported.",
      }),
    }),
    async execute(_toolCallId, { query }) {
      const normalizedQuery = query.trim().toLowerCase();
      if (!normalizedQuery) {
        return {
          content: [
            { type: "text", text: "Provide a capability, tool, or server name to search." },
          ],
          details: {},
        };
      }

      const discoveredTools = await discoverMcpTools(getConnections());
      const discoveredToolsByName = new Map(
        discoveredTools.map((discoveredTool) => [
          `${discoveredTool.connection.name}_${discoveredTool.tool.name}`,
          discoveredTool,
        ]),
      );
      const matchingTools = getMcpToolMatches(
        normalizedQuery,
        discoveredTools.map(({ connection, tool }) => ({
          serverName: connection.name,
          toolName: tool.name,
          ...(tool.description ? { description: tool.description } : {}),
        })),
      ).flatMap((match) => {
        const discoveredTool = discoveredToolsByName.get(`${match.serverName}_${match.toolName}`);
        return discoveredTool ? [discoveredTool] : [];
      });
      if (matchingTools.length === 0) {
        return {
          content: [{ type: "text", text: `No MCP tools found matching "${query}".` }],
          details: {},
        };
      }

      const activeTools = new Set(pi.getActiveTools());
      const loadedTools = matchingTools.map((discoveredTool) => {
        const name = `${discoveredTool.connection.name}_${discoveredTool.tool.name}`;
        if (!registeredToolNames.has(name)) {
          registeredToolNames.add(registerMcpTool(pi, discoveredTool));
        }
        activeTools.add(name);
        return `${name}: ${discoveredTool.tool.description || discoveredTool.tool.name}`;
      });
      pi.setActiveTools([...activeTools]);

      return {
        content: [{ type: "text", text: `Loaded MCP tools:\n${loadedTools.join("\n")}` }],
        details: {},
      };
    },
  });
}
