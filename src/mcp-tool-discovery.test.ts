import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import type {
  ExtensionAPI,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Tool } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";

import { closeMcps, connectMcp } from "./mcp-clients.js";
import { filterTools, publishMcpTools } from "./mcp-tool-discovery.js";

const read: Tool = {
  name: "read_item",
  description: "Read an item",
  inputSchema: { type: "object", properties: {} },
  annotations: { readOnlyHint: true },
};

const write: Tool = {
  name: "write_item",
  description: "Write an item",
  inputSchema: { type: "object", properties: {} },
};

describe("MCP tool publication", () => {
  it("honors exact and read-only wildcard filters", () => {
    expect(filterTools([read, write], ["write_item"])).toEqual([write]);
    expect(filterTools([read, write], ["*"])).toEqual([read, write]);
    expect(filterTools([read, write], ["*", "write_item"])).toEqual([write, read]);
  });

  it("publishes allowed tools to the shared registry and forwards calls to the server", async () => {
    let calls = 0;

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
        if (request.headers["x-fail-tools"] === "yes") {
          response.writeHead(500).end();

          return;
        }

        result = { tools: [read, write] };
      } else if (message.method === "tools/call") {
        calls++;
        expect(message.params).toMatchObject({ name: "read_item", arguments: { key: "abc" } });
        result = {
          content: [
            { type: "text", text: "found" },
            { type: "resource_link", uri: "file:///item", name: "item" },
          ],
          _meta: { source: "fixture" },
        };
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
    // SAFETY: A listening TCP server has an AddressInfo with an ephemeral port.
    const { port } = server.address() as AddressInfo;

    const connection = await connectMcp(
      { type: "http", url: `http://127.0.0.1:${port}/mcp`, tools: ["*", "read_item"] },
      "fixture-server",
      process.cwd(),
    );

    const unavailable = await connectMcp(
      {
        type: "http",
        url: `http://127.0.0.1:${port}/mcp`,
        headers: { "x-fail-tools": "yes" },
      },
      "unavailable",
      process.cwd(),
    );

    try {
      expect(connection).toBeDefined();
      expect(unavailable).toBeDefined();

      if (!connection) throw new Error("Expected an MCP connection");

      const publications: ToolDefinition[] = [];
      const listeners = new Map<string, (() => void)[]>();

      // SAFETY: Publication uses only pi.events; no other ExtensionAPI methods are called.
      const pi = {
        events: {
          on(name: string, listener: () => void) {
            listeners.set(name, [...(listeners.get(name) ?? []), listener]);
          },
          emit(name: string, data: { tool: ToolDefinition }) {
            if (name === "pi-dynamic-tools:register") publications.push(data.tool);
          },
        },
      } as ExtensionAPI;

      if (!unavailable) throw new Error("Expected the second server to connect");

      await publishMcpTools(pi, [unavailable, connection]);
      expect(publications.map((tool) => tool.name)).toEqual(["fixture_server_read_item"]);
      expect(listeners.get("pi-dynamic-tools:collect")).toHaveLength(1);
      listeners.get("pi-dynamic-tools:collect")?.[0]?.();
      expect(publications).toHaveLength(2);

      const tool = publications[0];

      if (!tool) throw new Error("Expected a published tool");
      // SAFETY: This tool does not use the extension context.
      const ctx = {} as ExtensionToolContext;
      const result = await tool.execute("id", { key: "abc" }, undefined, undefined, ctx);
      expect(result).toMatchObject({
        content: [{ type: "text", text: "found" }],
        details: { source: "fixture" },
      });
      expect(calls).toBe(1);
    } finally {
      await closeMcps([connection, unavailable].filter((item) => item !== undefined));
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
