import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import mcpExtension from "./index.js";
import { registerMcpServer, REGISTER_MCP_SERVER } from "./register.js";

// Exercise the extension against a real HTTP MCP peer (rather than mocking the SDK).
describe("MCP server registration", () => {
  it("combines files and pre-start events, and accepts new servers during the session", async () => {
    const server = createServer(async (request, response) => {
      if (request.method === "DELETE") {
        response.writeHead(200).end();

        return;
      }

      if (request.method === "GET") {
        response.writeHead(405).end();

        return;
      }

      let body = "";

      for await (const chunk of request) body += chunk.toString();
      const message = JSON.parse(body);
      let result;

      if (message.method === "initialize") {
        result = {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "fixture", version: "1.0.0" },
        };
      } else if (message.method === "tools/list") {
        result = { tools: [{ name: "ping", inputSchema: { type: "object", properties: {} } }] };
      } else {
        response.writeHead(202).end();

        return;
      }

      response.writeHead(200, {
        "content-type": "application/json",
        "mcp-session-id": "test-session",
      });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    // SAFETY: The listening server uses a TCP port.
    const { port } = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}/mcp`;
    const cwd = await mkdtemp(join(tmpdir(), "pi-mcp-register-"));
    await writeFile(
      join(cwd, ".mcp.json"),
      JSON.stringify({
        file: { type: "http", url },
        override: { type: "http", url: "http://127.0.0.1:1" },
      }),
    );

    const handlers = new Map<string, (ctx: ExtensionContext) => Promise<void>>();

    const listeners = new Map<
      string,
      ((data: Parameters<ExtensionAPI["events"]["emit"]>[1]) => void)[]
    >();

    const publications: ToolDefinition[] = [];

    // SAFETY: The extension only uses these API methods in this test.
    const pi = {
      // SAFETY: The test replaces this with lifecycle handler capture below.
      on: (() => () => {}) as ExtensionAPI["on"],
      registerFlag() {},
      getFlag() {
        return undefined;
      },
      events: {
        on(name: string, listener: (data: Parameters<ExtensionAPI["events"]["emit"]>[1]) => void) {
          listeners.set(name, [...(listeners.get(name) ?? []), listener]);

          return () => {};
        },
        emit(name: string, data: Parameters<ExtensionAPI["events"]["emit"]>[1]) {
          if (name === "pi-dynamic-tools:register") {
            // SAFETY: registerDynamicTool sends a tool definition on this channel.
            publications.push((data as { tool: ToolDefinition }).tool);
          }

          for (const listener of listeners.get(name) ?? []) listener(data);
        },
      },
    } as Pick<ExtensionAPI, "events" | "on">;

    pi.on = (name, handler) => {
      if (name === "session_start" || name === "session_shutdown") {
        // SAFETY: Neither handler inspects the event object in this test.
        handlers.set(name, async (ctx) => {
          // SAFETY: Session handlers in this fixture ignore their event argument.
          await handler(undefined as never, ctx);
        });
      }

      return () => {};
    };

    // SAFETY: Session startup only reads the cwd from the context.
    const ctx = { cwd } as ExtensionContext;
    registerMcpServer(pi, "early", { type: "http", url });
    // SAFETY: The mock supplies all API members used by the extension.
    mcpExtension(pi as ExtensionAPI);

    try {
      registerMcpServer(pi, "override", { type: "http", url });
      pi.events.emit(REGISTER_MCP_SERVER, { name: "invalid", entry: { command: 123 } });
      await handlers.get("session_start")?.(ctx);
      expect(publications.map((tool) => tool.name).sort()).toEqual([
        "early_ping",
        "file_ping",
        "override_ping",
      ]);

      registerMcpServer(pi, "late", { type: "http", url, tools: ["ping"] });
      // The event bus is fire-and-forget; wait for the queued connection.
      await vi.waitFor(() => expect(publications).toHaveLength(4));
      expect(publications.map((tool) => tool.name).sort()).toEqual([
        "early_ping",
        "file_ping",
        "late_ping",
        "override_ping",
      ]);
      await handlers.get("session_shutdown")?.(ctx);
      registerMcpServer(pi, "next-session", { type: "http", url });
      expect(publications).toHaveLength(4);
    } finally {
      await handlers.get("session_shutdown")?.(ctx);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
