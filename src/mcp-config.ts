import { readFile, stat } from "node:fs/promises";
import * as path from "node:path";

import { Type } from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { Compile } from "typebox/compile";

import type { McpConfig, McpEntry } from "./mcp-types.js";

/** Configuration files in each directory, in ascending precedence order. */
const MCP_CONFIG_FILES = ["mcp.json", ".mcp.json"];

/** JSON Schema describing the supported MCP server transport configurations. */
const mcpEntrySchema = Type.Union([
  Type.Object({
    type: Type.Optional(Type.Literal("local")),
    command: Type.String(),
    args: Type.Array(Type.String()),
    env: Type.Optional(Type.Record(Type.String(), Type.String())),
    tools: Type.Optional(Type.Array(Type.String())),
  }),
  Type.Object({
    type: Type.Literal("http"),
    url: Type.String({ format: "uri" }),
    headers: Type.Optional(Type.Record(Type.String(), Type.String())),
    tools: Type.Optional(Type.Array(Type.String())),
  }),
]);

const mcpSchema = Type.Record(Type.String(), mcpEntrySchema);

/** Compiled validators for file/flag configuration and event registrations. */
const McpSchema = Compile(mcpSchema);

const ServersSchema = Compile(Type.Object({ servers: mcpSchema }));

const McpServersSchema = Compile(Type.Object({ mcpServers: mcpSchema }));

/** Accept flat server maps and the two common wrapper formats. */
function parseMcpConfig(json: string): McpConfig {
  const data: unknown = JSON.parse(json);

  if (McpSchema.Check(data)) return McpSchema.Parse(data);

  if (ServersSchema.Check(data)) return ServersSchema.Parse(data).servers;

  return McpServersSchema.Parse(data).mcpServers;
}

const RegistrationSchema = Compile(
  Type.Object({ name: Type.String({ minLength: 1 }), entry: mcpEntrySchema }),
);

/** Reject malformed event payloads without interrupting other extensions. */
export function parseMcpRegistration(
  data: Parameters<ExtensionAPI["events"]["emit"]>[1],
): { name: string; entry: McpEntry } | undefined {
  try {
    return RegistrationSchema.Parse(data);
  } catch {
    return undefined;
  }
}

/** Determines whether an --mcp value identifies an existing file. */
async function isConfigFile(option: string | undefined): Promise<boolean> {
  if (!option) return false;

  try {
    return (await stat(option)).isFile();
  } catch {
    return false;
  }
}

/**
 * Loads and merges MCP configuration from the agent directory, session directory,
 * optional configured directories, and the --mcp flag. Later sources override
 * earlier sources with the same server name.
 */
export async function loadMcpConfig(pi: ExtensionAPI, ctx: ExtensionContext): Promise<McpConfig> {
  const mcpConfig: McpConfig = {};

  const configDirs = Array.from(
    new Set([
      getAgentDir(),
      ctx.cwd,
      ...(process.env.PI_MCP_CONFIG_DIRS?.split(",").filter((directory) => directory.trim()) ?? []),
    ]),
  );

  // SAFETY: `mcp` is registered with `type: "string"` in this extension's registerFlag call, so its value is `string | undefined`.
  const mcpOption = pi.getFlag("mcp") as string | undefined;
  const isFileOption = await isConfigFile(mcpOption);

  const files = configDirs.flatMap((directory) =>
    MCP_CONFIG_FILES.map((filename) => path.join(directory, filename)),
  );

  if (isFileOption && mcpOption) {
    files.push(mcpOption);
  }

  for (const file of files) {
    try {
      const parsed = parseMcpConfig(await readFile(file, "utf-8"));
      Object.assign(mcpConfig, parsed);
    } catch {
      // Invalid or missing configuration must not prevent the extension loading.
    }
  }

  if (!isFileOption && mcpOption) {
    try {
      const parsed = parseMcpConfig(mcpOption);
      Object.assign(mcpConfig, parsed);
    } catch {
      // Invalid inline configuration must not prevent the extension loading.
    }
  }

  return mcpConfig;
}
