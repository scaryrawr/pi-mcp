import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, it } from "vitest";

import { closeMcps, connectMcp } from "./mcp-clients.js";

/** A minimal Streamable HTTP peer for exercising the real SDK transport. */
async function withMcpServer(
  run: (
    url: string,
    requests: { method: string; authorization: string | undefined }[],
  ) => Promise<void>,
) {
  const requests: { method: string; authorization: string | undefined }[] = [];

  const server = createServer(async (request, response) => {
    requests.push({ method: request.method ?? "", authorization: request.headers.authorization });

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

    if (message.method === "initialize") {
      response.writeHead(200, {
        "content-type": "application/json",
        "mcp-session-id": "test-session",
      });
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            serverInfo: { name: "fixture", version: "1.0.0" },
          },
        }),
      );
    } else {
      response.writeHead(202).end();
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  // SAFETY: Listening on a TCP host and ephemeral port gives server.address() an AddressInfo.
  const { port } = server.address() as AddressInfo;

  try {
    await run(`http://127.0.0.1:${port}/mcp`, requests);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

describe("MCP connections", () => {
  it("sends configured headers and terminates HTTP sessions on shutdown", async () => {
    await withMcpServer(async (url, requests) => {
      const connection = await connectMcp(
        { type: "http", url, headers: { Authorization: "Bearer secret" } },
        "remote",
        "/project",
      );

      expect(connection).toBeDefined();

      if (!connection) throw new Error("Expected the HTTP server to connect");

      await closeMcps([connection]);

      expect(requests.some((request) => request.method === "DELETE")).toBe(true);
      expect(requests.every((request) => request.authorization === "Bearer secret")).toBe(true);
    });
  });

  it("does not prevent startup when a local server cannot be spawned", async () => {
    const result = await connectMcp(
      { command: "pi-mcp-nonexistent-server-command", args: [] },
      "missing",
      process.cwd(),
    );

    expect(result).toBeUndefined();
  });
});
