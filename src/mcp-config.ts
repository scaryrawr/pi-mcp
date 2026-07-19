import { readFile, stat } from "node:fs/promises";
import * as path from "node:path";

import { Type } from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { Compile } from "typebox/compile";

import type { McpConfig } from "./mcp-types.js";

/** Name of the MCP configuration file searched in each configuration directory. */
const MCP_CONFIG_FILE = ".mcp.json";

/** JSON Schema describing the supported MCP server transport configurations. */
const mcpSchema = Type.Record(
  Type.String(),
  Type.Union([
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
  ]),
);

/** Compiled validator for MCP configuration files and inline configuration. */
const McpSchema = Compile(mcpSchema);

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
  const mcpOption = pi.getFlag("mcp") as string | undefined;
  const isFileOption = await isConfigFile(mcpOption);
  const files = configDirs.map((directory) => path.join(directory, MCP_CONFIG_FILE));

  if (isFileOption && mcpOption) {
    files.push(mcpOption);
  }

  for (const file of files) {
    try {
      const parsed: McpConfig = McpSchema.Parse(JSON.parse(await readFile(file, "utf-8")));
      Object.assign(mcpConfig, parsed);
    } catch {
      // Invalid or missing configuration must not prevent the extension loading.
    }
  }

  if (!isFileOption && mcpOption) {
    try {
      const parsed: McpConfig = McpSchema.Parse(JSON.parse(mcpOption));
      Object.assign(mcpConfig, parsed);
    } catch {
      // Invalid inline configuration must not prevent the extension loading.
    }
  }

  return mcpConfig;
}
