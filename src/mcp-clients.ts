import {
  Client,
  StreamableHTTPClientTransport,
  type Transport,
  type StreamableHTTPClientTransportOptions,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import { McpOAuthProvider } from "./mcp-oauth.js";
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
    const provider = entry.oauth
      ? await McpOAuthProvider.create(
          name,
          entry,
          `http://127.0.0.1:${entry.oauth.port ?? 8765}/callback`,
        )
      : undefined;

    if (provider && !provider.hasTokens()) return undefined;

    const options: StreamableHTTPClientTransportOptions = {};

    // SDK-generated HTTP/MCP/auth headers take precedence over configured ones.
    // Never forward configured headers across origins via an automatic redirect.
    if (entry.headers) {
      const headers = Object.fromEntries(
        Object.entries(entry.headers).filter(([key]) => {
          const name = key.toLowerCase();

          return (
            !["accept", "content-type", "mcp-session-id", "mcp-protocol-version"].includes(name) &&
            !(provider && name === "authorization")
          );
        }),
      );

      options.requestInit = { headers, redirect: "manual" };
    }

    if (provider) options.authProvider = provider;

    transport = new StreamableHTTPClientTransport(new URL(entry.url), options);
  } else {
    transport = new StdioClientTransport({
      ...entry,
      cwd: entry.cwd ?? cwd,
      // TODO: handle stderr output (e.g. log it) instead of ignoring.
      stderr: "ignore",
    });
  }

  try {
    await client.connect(transport);

    return { name, client, entry, transport };
  } catch {
    try {
      await client.close();
    } catch {
      // A failed handshake must not prevent the other servers from connecting.
    }

    return undefined;
  }
}

/** Closes MCP connections without preventing extension shutdown. */
export async function closeMcps(connections: McpConnection[]): Promise<void> {
  await Promise.all(
    connections.map(async ({ client, transport }) => {
      try {
        if (transport instanceof StreamableHTTPClientTransport) {
          await transport.terminateSession();
        }
      } catch {
        // Still close the transport if the server cannot terminate the session.
      }

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
