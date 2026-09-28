import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import { closeMcps, connectMcp } from "./mcp-clients.js";
import { loadPluginMcp } from "./plugin-mcp.js";
import { registerMcpPlugin } from "./register.js";

const pluginSchema = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";

const mcpSchema = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

const roots: string[] = [];

type FixtureServers = Record<
  string,
  {
    type: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
    url?: string;
    headers?: Record<string, string>;
  }
>;

async function fixture(
  manifest: { $schema: string; name: string; unexpected?: boolean; extensions?: number },
  servers: FixtureServers,
) {
  const directory = await mkdtemp(join(tmpdir(), "pi-mcp-plugin-"));
  roots.push(directory);
  const root = join(directory, "plugin");
  const data = join(directory, "persistent-data");
  await mkdir(root);
  await writeFile(join(root, "plugin.json"), JSON.stringify(manifest));
  await writeFile(
    join(root, "mcp.json"),
    JSON.stringify({ $schema: mcpSchema, mcpServers: servers }),
  );

  return { root, data, directory };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Agent Plugins MCP event registration", () => {
  it("resolves subprocess paths and variables, isolates bad servers, and replays events", async () => {
    const { root, data } = await fixture(
      { $schema: pluginSchema, name: "tools.demo", unexpected: true, extensions: 42 },
      {
        local: {
          type: "stdio",
          command: "./server.js",
          args: ["${PLUGIN_ROOT}/config", "${PLUGIN_DATA}/cache", "$HOME"],
          env: { CUSTOM: "${PLUGIN_DATA}/x" },
          cwd: "${PLUGIN_DATA}/work",
        },
        remote: {
          type: "streamable-http",
          url: "https://example.org/mcp",
          headers: { "X-Test": "${PLUGIN_ROOT}" },
        },
        wrong: { type: "stdio", command: "../escape", args: [] },
        reserved: { type: "stdio", command: "node", env: { PLUGIN_ROOT: "bad" } },
        legacy: { type: "sse", url: "https://example.org/sse" },
      },
    );

    await writeFile(join(root, "server.js"), "");
    await mkdir(join(data, "work"), { recursive: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const events: { channel: string; data: unknown }[] = [];
    const listeners = new Map<string, () => void>();

    // SAFETY: The helper only uses the event bus's on and emit methods.
    const pi = {
      events: {
        on(channel: string, listener: () => void) {
          listeners.set(channel, listener);

          return () => {};
        },
        emit(channel: string, value: Parameters<ExtensionAPI["events"]["emit"]>[1]) {
          events.push({ channel, data: value });
        },
      },
    } as Pick<ExtensionAPI, "events">;

    await registerMcpPlugin(pi, root, data);
    const resolvedRoot = await realpath(root);
    const resolvedData = await realpath(data);
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      channel: "pi-mcp:register",
      data: {
        name: "tools.demo_local",
        entry: expect.objectContaining({
          type: "local",
          command: join(resolvedRoot, "server.js"),
          cwd: join(resolvedData, "work"),
          args: [join(resolvedRoot, "config"), join(resolvedData, "cache"), "$HOME"],
          env: expect.objectContaining({
            CUSTOM: join(resolvedData, "x"),
            PLUGIN_ROOT: resolvedRoot,
            PLUGIN_DATA: resolvedData,
          }),
        }),
      },
    });
    expect(events[1]).toEqual({
      channel: "pi-mcp:register",
      data: {
        name: "tools.demo_remote",
        entry: {
          type: "http",
          url: "https://example.org/mcp",
          headers: { "X-Test": "${PLUGIN_ROOT}" },
        },
      },
    });
    listeners.get("pi-mcp:collect")?.();
    expect(events).toHaveLength(3); // Each server helper owns its own replay listener; this fixture stores one.
    expect(warn).toHaveBeenCalled();
    expect(await readFile(join(root, "server.js"), "utf8")).toBe("");
  });

  it("launches a real stdio peer with resolved cwd and plugin environment", async () => {
    const { root, data } = await fixture(
      { $schema: pluginSchema, name: "local" },
      {
        server: {
          type: "stdio",
          command: "./server.cjs",
          env: { NOTE: "${PLUGIN_DATA}/note" },
          cwd: "${PLUGIN_DATA}",
        },
      },
    );

    const script = join(root, "server.cjs");
    await writeFile(
      script,
      `#!/usr/bin/env node
const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const result = request.method === 'initialize'
    ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'local', version: '1' } }
    : request.method === 'tools/list'
      ? { tools: [{ name: 'where', inputSchema: { type: 'object', properties: {} } }] }
      : { content: [{ type: 'text', text: JSON.stringify({ cwd: process.cwd(), root: process.env.PLUGIN_ROOT, data: process.env.PLUGIN_DATA, note: process.env.NOTE }) }] };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
});
`,
    );
    await chmod(script, 0o755);
    const entry = (await loadPluginMcp(root, data)).get("local_server");

    if (!entry) throw new Error("Expected stdio entry");
    const connection = await connectMcp(entry, "local_server", "/unrelated-session-directory");
    expect(connection).toBeDefined();

    if (!connection) return;

    try {
      expect((await connection.client.listTools()).tools.map((tool) => tool.name)).toEqual([
        "where",
      ]);
      const result = await connection.client.callTool({ name: "where", arguments: {} });
      expect(result.content).toEqual([
        {
          type: "text",
          text: JSON.stringify({
            cwd: await realpath(data),
            root: await realpath(root),
            data: await realpath(data),
            note: join(await realpath(data), "note"),
          }),
        },
      ]);
    } finally {
      await closeMcps([connection]);
    }
  });

  it("rejects invalid manifests and disables only the MCP component for invalid top-level config", async () => {
    const { root, data } = await fixture(
      { $schema: pluginSchema, name: "Invalid" },
      { good: { type: "stdio", command: "node" } },
    );

    await expect(loadPluginMcp(root, data)).rejects.toThrow("plugin.json");
    await writeFile(
      join(root, "plugin.json"),
      JSON.stringify({ $schema: pluginSchema, name: "valid" }),
    );
    await writeFile(
      join(root, "mcp.json"),
      JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/2.0.0/mcp.schema.json",
        mcpServers: {},
      }),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await loadPluginMcp(root, data)).size).toBe(0);
  });

  it("rejects escaping symlinks and unsafe URLs and headers without dropping other servers", async () => {
    const { root, data, directory } = await fixture(
      { $schema: pluginSchema, name: "safe" },
      {
        escaped: { type: "stdio", command: "./outside" },
        cwd: { type: "stdio", command: "node", cwd: "${PLUGIN_DATA}/../" },
        insecure: { type: "streamable-http", url: "http://example.org/mcp" },
        credentials: { type: "streamable-http", url: "https://user@example.org/mcp" },
        duplicate: {
          type: "streamable-http",
          url: "https://example.org/mcp",
          headers: { "X-Key": "a", "x-key": "b" },
        },
        valid: { type: "stdio", command: "node" },
      },
    );

    await writeFile(join(directory, "outside"), "");
    await symlink(join(directory, "outside"), join(root, "outside"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const entries = await loadPluginMcp(root, data);
    expect([...entries.keys()]).toEqual(["safe_valid"]);
    expect(entries.get("safe_valid")).toMatchObject({
      cwd: await realpath(root),
      args: [],
      env: { PLUGIN_ROOT: await realpath(root), PLUGIN_DATA: await realpath(data) },
    });
  });
});
