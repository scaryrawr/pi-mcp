import {
  Client,
  StreamableHTTPClientTransport,
  type Transport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import type { McpConnection, McpEntry } from "./mcp-types.js";

/**
 * Connects to an MCP server using its configured transport.
 * Returns undefined when the server cannot be reached.
 */
export async function connectMcp(
  entry: McpEntry,
  name: string,
  cwd: string,
): Promise<McpConnection | undefined> {
  const client = new Client({ name: `pi-mcp-${name}`, version: "1.0.0" });
  let transport: Transport;

  if (entry.type === "http") {
    transport = new StreamableHTTPClientTransport(new URL(entry.url));
  } else {
    transport = new StdioClientTransport({
      ...entry,
      cwd,
      // TODO: handle stderr output (e.g. log it) instead of ignoring.
      stderr: "ignore",
    });
  }

  try {
    await client.connect(transport);
    return { name, client, entry, transport };
  } catch {
    return undefined;
  }
}

/** Closes MCP connections without preventing extension shutdown. */
export async function closeMcps(connections: McpConnection[]): Promise<void> {
  await Promise.all(
    connections.map(async ({ client }) => {
      try {
        await client.close();
      } catch {
        // Ignore MCP shutdown failures.
      }
    }),
  );
}

/** Narrows a value to a defined value. */
export function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
