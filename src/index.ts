import { readFile } from "node:fs/promises";
import * as path from "node:path";

import { Type, type Static } from "@mariozechner/pi-ai";
import { type ExtensionAPI, getAgentDir } from "@mariozechner/pi-coding-agent";
import type { Tool } from "@modelcontextprotocol/client";
import {
  Client,
  StreamableHTTPClientTransport,
  StdioClientTransport,
  type Transport,
} from "@modelcontextprotocol/client";
import { Compile } from "typebox/compile";

/**
 * JSON Schema describing the MCP configuration file structure.
 * Maps server names to their transport configuration (local/stdio or http).
 */
const mcpSchema = Type.Record(
  Type.String(),
  Type.Union([
    /** Local (stdio) transport configuration */
    Type.Object({
      /** Transport type, defaults to "local" */
      type: Type.Optional(Type.Literal("local")),
      /** Command to execute for the MCP server */
      command: Type.String(),
      /** Arguments to pass to the command */
      args: Type.Array(Type.String()),
      /** Environment variables for the process */
      env: Type.Optional(Type.Record(Type.String(), Type.String())),
      /** Optional filter: list of tool names to register (empty = all) */
      tools: Type.Optional(Type.Array(Type.String())),
    }),
    /** HTTP transport configuration */
    Type.Object({
      /** Transport type: "http" */
      type: Type.Literal("http"),
      /** URL of the MCP server */
      url: Type.String({
        format: "uri",
      }),
      /** Optional HTTP headers (e.g. authorization) */
      headers: Type.Optional(Type.Record(Type.String(), Type.String())),
      /** Optional filter: list of tool names to register (empty = all) */
      tools: Type.Optional(Type.Array(Type.String())),
    }),
  ]),
);

/** Compiled validation schema for the MCP configuration. */
const McpSchema = Compile(mcpSchema);

/** Type representing the full MCP configuration object (server name → entry). */
type McpConfig = Static<typeof mcpSchema>;

/** Type representing a single MCP server entry from the config. */
type McpEntry = McpConfig[string];

/** Represents an MCP server entry after loading it from disk. */
type ResolvedMcpEntry = {
  /** Original config entry for this server */
  entry: McpEntry;
  /** Directory containing the `.mcp.json` file this entry came from */
  cwd: string;
};

/** Represents an active MCP server connection, including its transport and config. */
type McpConnection = {
  /** Human-readable server name (key from the config) */
  name: string;
  /** MCP client instance connected to the server */
  client: Client;
  /** Original config entry for this server */
  entry: McpEntry;
  /** Transport layer (stdio or http) */
  transport: Transport;
};

/** Path to the MCP configuration file (relative to agent dir or session cwd). */
const MCP_CONFIG_FILE = ".mcp.json";

/**
 * Establishes a connection to an MCP server using the given resolved config entry.
 * @param resolvedEntry - The server configuration entry and source directory.
 * @param name - Human-readable server name (used as client name prefix).
 * @returns A McpConnection object if successful, undefined if connection fails.
 */
async function connect(
  resolvedEntry: ResolvedMcpEntry,
  name: string,
): Promise<McpConnection | undefined> {
  const { entry, cwd } = resolvedEntry;
  const client = new Client({ name: `pi-mcp-${name}`, version: "1.0.0" });
  let transport: Transport;

  if (entry.type === "http") {
    const url = new URL(entry.url);
    transport = new StreamableHTTPClientTransport(url, {
      // todo: Process rest of the entry config
    });
  } else {
    transport = new StdioClientTransport({ ...entry, cwd });
  }

  try {
    await client.connect(transport);
    return { name, client, entry, transport };
  } catch {
    return undefined;
  }
}

/**
 * Type guard: narrows a value to non-undefined.
 */
function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

/**
 * Registers tools from MCP server connections with the pi agent.
 * @param pi - The pi ExtensionAPI instance.
 * @param connections - Active MCP server connections.
 */
async function registerMcps(pi: ExtensionAPI, connections: McpConnection[]) {
  for (const connection of connections) {
    const { name, client, entry } = connection;
    const toolsFilter = entry.tools;

    // Get all available tools from this server
    const capabilities = client.getServerCapabilities();
    if (!capabilities?.tools) {
      continue;
    }

    // Fetch the list of tools
    const toolsResponse = await client.listTools();
    const allTools = toolsResponse.tools;

    // Determine which tools to register
    let toolsToRegister: Tool[];

    if (
      !toolsFilter ||
      toolsFilter.length === 0 ||
      (toolsFilter.length === 1 && toolsFilter[0] === "*")
    ) {
      // No filter or only "*": register all tools
      toolsToRegister = allTools;
    } else if (toolsFilter.includes("*")) {
      // "*" combined with specific names means read-only tools + explicitly named tools
      const explicitToolNames = toolsFilter.filter((n) => n !== "*");
      const explicitTools = allTools.filter((t) => explicitToolNames.includes(t.name));

      // A tool is considered read-only if it doesn't have required parameters
      const readOnlyTools = allTools.filter((t) => t.annotations?.readOnlyHint);

      const explicitToolSet = new Set(explicitTools.map((t) => t.name));
      toolsToRegister = [
        ...explicitTools,
        ...readOnlyTools.filter((t) => !explicitToolSet.has(t.name)),
      ];
    } else {
      // Specific tool names only
      toolsToRegister = allTools.filter((t) => toolsFilter.includes(t.name));
    }

    // Register each tool with the prefix
    for (const tool of toolsToRegister) {
      pi.registerTool({
        name: `${name}_${tool.name}`,
        label: tool.name,
        description: tool.description || tool.name,
        parameters: Type.Unsafe<Record<string, unknown>>(tool.inputSchema),
        /**
         * Executes the tool by forwarding the call to the connected MCP server.
         */
        async execute(_toolCallId, args, _signal, _onUpdate, _ctx) {
          const result = await client.callTool({
            name: tool.name,
            arguments: args,
          });
          return {
            content: result.content.filter((c) => c.type === "text" || c.type === "image"),
            details: (result._meta ?? {}) as Record<string, unknown>,
          };
        },
      });
    }
  }
}

/**
 * Reads MCP config from the global agent dir and the current pi session cwd.
 * Project config overrides global config for servers with the same name.
 * @param cwd - The current pi session working directory.
 */
async function loadMcpConfig(cwd: string): Promise<Record<string, ResolvedMcpEntry>> {
  const mcpConfig: Record<string, ResolvedMcpEntry> = {};
  const configDirs = Array.from(new Set([getAgentDir(), cwd]));

  for (const configDir of configDirs) {
    try {
      const config = await readFile(path.join(configDir, MCP_CONFIG_FILE), "utf-8");
      const parsed = McpSchema.Parse(JSON.parse(config));
      for (const [name, entry] of Object.entries(parsed)) {
        mcpConfig[name] = { entry, cwd: configDir };
      }
    } catch {
      // Ignore errors on MCP load failures
    }
  }

  return mcpConfig;
}

/**
 * Closes MCP server connections without preventing extension shutdown.
 * @param connections - Active MCP server connections.
 */
async function closeMcps(connections: McpConnection[]) {
  await Promise.all(
    connections.map(async ({ client }) => {
      try {
        await client.close();
      } catch {
        // Ignore MCP shutdown failures
      }
    }),
  );
}

/**
 * Main extension entry point. Reads the MCP config, connects to each server,
 * and registers available tools with the pi agent.
 * @param pi - The pi ExtensionAPI instance.
 */
export default function (pi: ExtensionAPI) {
  let connections: McpConnection[] = [];
  let initialized = false;

  pi.on("session_start", async (_event, ctx) => {
    if (initialized) return;
    initialized = true;

    const mcpConfig = await loadMcpConfig(ctx.cwd);
    connections = (
      await Promise.all(
        Object.entries(mcpConfig).map(([name, entry]) => {
          return connect(entry, name);
        }),
      )
    ).filter(isDefined);

    await registerMcps(pi, connections);
  });

  pi.on("session_shutdown", async () => {
    await closeMcps(connections);
    connections = [];
    initialized = false;
  });
}
