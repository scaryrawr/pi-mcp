import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { closeMcps, connectMcp } from "./mcp-clients.js";
import { loadMcpConfig, parseMcpRegistration } from "./mcp-config.js";
import { loginMcp } from "./mcp-oauth.js";
import { publishMcpTools } from "./mcp-tool-discovery.js";
import type { McpConnection, McpEntry } from "./mcp-types.js";
import { COLLECT_MCP_SERVERS, REGISTER_MCP_SERVER } from "./register.js";

/**
 * Manages session-scoped MCP connections and publishes tools to pi-dynamic-tools.
 * Registrations received before session start are retained for that session.
 */
export default function (pi: ExtensionAPI): void {
  const registrations = new Map<string, McpEntry>();
  const connections = new Map<string, McpConnection>();
  let configured = new Map<string, McpEntry>();
  let cwd: string | undefined;
  let pending: Promise<void> = Promise.resolve();

  async function addServer(name: string, entry: McpEntry, sessionCwd: string): Promise<void> {
    // A server already published for this session cannot be safely replaced:
    // pi-dynamic-tools does not support removing registered tool definitions.
    if (connections.has(name)) return;

    try {
      const connection = await connectMcp(entry, name, sessionCwd);

      if (!connection) return;
      connections.set(name, connection);
      await publishMcpTools(pi, [connection]);
    } catch {
      // Invalid or unavailable servers must not prevent other servers from loading.
    }
  }

  pi.events.on(REGISTER_MCP_SERVER, (data) => {
    const registration = parseMcpRegistration(data);

    if (!registration) return;

    const { name, entry } = registration;
    registrations.set(name, entry);

    if (cwd) {
      configured.set(name, entry);
      const sessionCwd = cwd;
      pending = pending.then(() => addServer(name, entry, sessionCwd));
    }
  });

  // Ask providers loaded before us to replay registrations.
  pi.events.emit(COLLECT_MCP_SERVERS, undefined);

  pi.on("session_start", async (_event, ctx) => {
    cwd = ctx.cwd;
    pending = pending.then(async () => {
      const config = await loadMcpConfig(pi, ctx);

      for (const [name, entry] of registrations) config[name] = entry;
      configured = new Map(Object.entries(config));
      await Promise.all(
        Object.entries(config).map(([name, entry]) => addServer(name, entry, ctx.cwd)),
      );
    });
    await pending;
  });

  pi.on("session_shutdown", async () => {
    cwd = undefined;
    await pending;
    await closeMcps([...connections.values()]);
    connections.clear();
    configured.clear();
  });

  pi.registerCommand("mcp-login", {
    description: "Authorize a configured HTTP MCP server (usage: /mcp-login server-name)",
    handler: async (args, ctx) => {
      const name = args.trim();
      const entry = configured.get(name);

      if (!entry || entry.type !== "http" || !entry.oauth) {
        ctx.ui.notify(`No OAuth HTTP MCP server named '${name}'.`, "error");

        return;
      }

      if (connections.has(name)) {
        ctx.ui.notify(
          `${name} is already connected; restart the session to replace it.`,
          "warning",
        );

        return;
      }

      try {
        await loginMcp(name, entry, ctx);
        await addServer(name, entry, ctx.cwd);
        ctx.ui.notify(
          connections.has(name) ? `${name} connected` : `${name} authorized, but connection failed`,
          connections.has(name) ? "info" : "error",
        );
      } catch (error) {
        ctx.ui.notify(
          `OAuth login failed for ${name}: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });

  pi.registerFlag("mcp", {
    description: "Add an mcp configuration JSON config or file path",
    type: "string",
  });
}
