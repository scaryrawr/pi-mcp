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

Each server entry supports:

- **Local (stdio)**: `command`, `args`, optional `env` and `tools` filter
- **HTTP**: `type: "http"`, `url`, optional `headers` and `tools` filter (uses Streamable HTTP; headers are sent with transport requests)

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

Tool filters constrain which tools pi-mcp publishes to `search_tools`. They can specify exact tool names, or use `"*"` to allow all tools. Combining `"*"` with specific names allows read-only tools plus the explicitly named ones.

## License

MIT
