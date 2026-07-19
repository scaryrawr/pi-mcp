import type { Client, Tool, Transport } from "@modelcontextprotocol/client";

/** Configuration for an MCP server launched as a local process. */
export type LocalMcpEntry = {
  /** Transport type, which defaults to local. */
  type?: "local";
  /** Command used to launch the server. */
  command: string;
  /** Arguments passed to the server command. */
  args: string[];
  /** Environment variables supplied to the server process. */
  env?: Record<string, string>;
  /** Allowlist of tools the extension may expose. */
  tools?: string[];
};

/** Configuration for an MCP server reached over HTTP. */
export type HttpMcpEntry = {
  /** HTTP transport discriminator. */
  type: "http";
  /** URL of the MCP server. */
  url: string;
  /** HTTP headers supplied to the server. */
  headers?: Record<string, string>;
  /** Allowlist of tools the extension may expose. */
  tools?: string[];
};

/** A configured MCP server transport. */
export type McpEntry = LocalMcpEntry | HttpMcpEntry;

/** Maps configured MCP server names to their transport configuration. */
export type McpConfig = Record<string, McpEntry>;

/** An active MCP server connection and the configuration that created it. */
export type McpConnection = {
  /** Human-readable server name (the configuration key). */
  name: string;
  /** Connected MCP client. */
  client: Client;
  /** Server configuration. */
  entry: McpEntry;
  /** Transport owned by the client. */
  transport: Transport;
};

/** An MCP tool paired with the connection that serves it. */
export type DiscoveredTool = {
  connection: McpConnection;
  tool: Tool;
};
