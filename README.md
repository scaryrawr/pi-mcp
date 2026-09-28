# pi-mcp

An MCP client extension for [pi](https://github.com/mariozechner/pi-coding-agent) that connects to Model Context Protocol (MCP) servers and publishes their tools to [pi-dynamic-tools](https://github.com/scaryrawr/pi-dynamic-tools) for on-demand activation.

## What it does

The extension reads `mcp.json` and `.mcp.json` configuration files (from both the agent directory and project working directory) and accepts server registrations from other pi extensions. It establishes connections to MCP servers — either via stdio (local processes) or HTTP (remote endpoints). It lists allowed tools at session start and offers them to the shared `search_tools` registry, prefixed with the server name (e.g., `server_toolName`; punctuation in names becomes `_`). Only tools selected by a search become active.

## How it works

1. On session start, pi-mcp loads `mcp.json` and `.mcp.json` from the agent directory and project cwd (project config overrides global) and merges event registrations (which override file entries with the same name).
2. For each server entry, it establishes a connection via stdio or Streamable HTTP transport.
3. It lists and filters tools from connected servers and publishes them to pi-dynamic-tools. A server that cannot list tools does not prevent other servers from working.
4. Use `search_tools` with a tool name or capability query to activate matching tools (keyword search by default; semantic search is also available). Tool calls are forwarded to the connected MCP server and returned with content filtering (text and image only).
5. New server registrations during a session connect and publish tools immediately. On session shutdown, all connections are cleanly closed. The shared registry handles tool activation per session.

## Installation

Install the extension using pi's built-in install command (Node.js 20+):

```bash
pi install git:github.com/scaryrawr/pi-dynamic-tools
pi install git:github.com/scaryrawr/pi-mcp
```

Both extensions must be loaded in pi. The `pi-dynamic-tools` dependency in pi-mcp supplies the publishing helper; it does not load the registry extension on its own. Without the separately installed registry, MCP tools are not searchable.

## Configuration

Tools are configured via `mcp.json` or `.mcp.json` files. Configuration is merged in this order (later entries with the same server name override earlier ones):

- `<pi agent directory>/mcp.json`, then `.mcp.json` — global configuration
- `<project>/mcp.json`, then `.mcp.json` — project working directory
- Directories in `PI_MCP_CONFIG_DIRS` (comma-separated), each with `mcp.json`, then `.mcp.json`
- `--mcp` with an inline JSON configuration or a file path

### Example

```json
{
  "chrome-devtools": {
    "command": "npx",
    "args": [
      "chrome-devtools-mcp@latest",
      "--no-usage-statistics",
      "--no-performance-crux",
      "--browser-url=http://127.0.0.1:9222"
    ]
  }
}
```

Server entries can be supplied as a flat map (as above), or nested under a top-level `servers` or `mcpServers` key. All three formats work in configuration files and with `--mcp` (inline JSON or a file path). For example, `{"mcpServers": {"my-server": {"command": "node", "args": ["server.js"]}}}` is equivalent to a flat map with `my-server` at the top level.

Each server entry supports:

- **Local (stdio)**: `command`, `args`, optional `env`, `cwd` and `tools` filter
- **HTTP**: `type: "http"`, `url`, optional `headers`, `oauth`, and `tools` filter (uses Streamable HTTP; headers are sent with transport requests)

### HTTP OAuth

For an OAuth-protected remote server, enable `oauth` and run `/mcp-login <server-name>` in an interactive pi session. Login uses the SDK's authorization-code flow with PKCE, a loopback callback at `http://127.0.0.1:8765/callback`, and server-advertised discovery and dynamic client registration. The login command opens a browser when available and also prints the authorization URL. Connections without saved tokens are skipped until you log in; login connects and publishes the server's tools in the current session. Existing bearer-token `headers` configuration remains supported without OAuth.

```json
{
  "remote": {
    "type": "http",
    "url": "https://mcp.example.com/mcp",
    "oauth": {}
  }
}
```

If the authorization server does not support dynamic registration, set `oauth.clientId` to a **public** pre-registered client ID. Alternatively, for servers supporting Client ID Metadata Documents, set `oauth.clientMetadataUrl` to a public HTTPS document hosted by you. Its redirect URI must match the loopback callback; if necessary, set `oauth.port` to a fixed port (1–65535, default 8765) and register `http://127.0.0.1:<port>/callback`. Do not put a shared client secret in project configuration. OAuth credentials (including refresh tokens) are saved under the pi agent directory's `mcp-oauth/` with owner-only file permissions; do not commit or share that directory. Each server name and URL gets separate credentials. Non-interactive modes can use existing credentials but cannot run login.

The extension uses the v2 `@modelcontextprotocol/client` SDK. It does not require the v1 `@modelcontextprotocol/sdk` package or a direct Zod dependency.

### Register from another extension

Import the helper from `pi-mcp` and call it once per server in your extension factory (or later, when a server becomes available):

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerMcpServer } from "pi-mcp";

export default function (pi: ExtensionAPI) {
  registerMcpServer(pi, "my-server", {
    type: "http",
    url: "http://localhost:3000/mcp",
    tools: ["*"],
  });
}
```

The helper publishes on `pi-mcp:register` with `{ name, entry }` and replays the registration when pi-mcp emits `pi-mcp:collect`, so extension load order does not matter. Registrations received before session start override matching file/flag entries. New names received while a session is running connect immediately; an already connected server cannot be replaced until the next session because published tools cannot be removed. Invalid events and unavailable servers are ignored. Event registrations are retained for subsequent sessions in the same extension instance.

### Agent Plugins v1 packages (event registration)

An installer/loader for the [Agent Plugins 1.0.0 format](https://github.com/agentplugins/agent-plugins-spec/blob/main/spec/1.0.0.md) can register the MCP components of an installed plugin:

```ts
import { registerMcpPlugin } from "pi-mcp";

// pluginRoot contains plugin.json and (optionally) mcp.json; pluginData is a
// persistent, writable directory dedicated to this installed plugin instance.
await registerMcpPlugin(pi, pluginRoot, pluginData);
```

The helper validates `plugin.json` and the fixed `mcp.json` location, then registers each valid server on the same replayable event channel as `registerMcpServer`. It prefixes server names with the manifest name (`my-plugin_server`). It supports portable `stdio` and `streamable-http`; legacy `sse` entries are skipped. It resolves contained plugin paths, sets `PLUGIN_ROOT` and `PLUGIN_DATA`, expands only the specified placeholders in stdio args/env/cwd, validates remote URLs and headers, and skips individual invalid servers without discarding their siblings. A missing `mcp.json` is fine. Invalid manifests reject the plugin; an invalid MCP component is ignored. The installer remains responsible for choosing a stable per-installation data path and discovering other component types (e.g. skills). This helper does not make native project/agent `mcp.json` files Agent Plugins packages: their existing formats and precedence remain unchanged. As with native event registrations, connected servers cannot be replaced until the next session.

Tool filters constrain which tools pi-mcp publishes to `search_tools`. They can specify exact tool names, or use `"*"` to allow all tools. Combining `"*"` with specific names allows read-only tools plus the explicitly named ones.

## License

MIT
