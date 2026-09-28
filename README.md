# pi-mcp

An MCP client extension for [pi](https://github.com/mariozechner/pi-coding-agent) that connects to Model Context Protocol (MCP) servers and publishes their tools to [pi-dynamic-tools](https://github.com/scaryrawr/pi-dynamic-tools) for on-demand activation.

## What it does

The extension reads `.mcp.json` configuration files (from both the agent directory and project working directory) and establishes connections to MCP servers — either via stdio (local processes) or HTTP (remote endpoints). It lists allowed tools at session start and offers them to the shared `search_tools` registry, prefixed with the server name (e.g., `server_toolName`; punctuation in names becomes `_`). Only tools selected by a search become active.

## How it works

1. On session start, pi-mcp loads `.mcp.json` from the agent directory and project cwd (project config overrides global).
2. For each server entry, it establishes a connection via stdio or Streamable HTTP transport.
3. It lists and filters tools from connected servers and publishes them to pi-dynamic-tools. A server that cannot list tools does not prevent other servers from working.
4. Use `search_tools` with a tool name or capability query to activate matching tools (keyword search by default; semantic search is also available). Tool calls are forwarded to the connected MCP server and returned with content filtering (text and image only).
5. On session shutdown, all connections are cleanly closed. The shared registry handles tool activation per session.

## Installation

Install the extension using pi's built-in install command (Node.js 20+):

```bash
pi install git:github.com/scaryrawr/pi-dynamic-tools
pi install git:github.com/scaryrawr/pi-mcp
```

Both extensions must be loaded in pi. The `pi-dynamic-tools` dependency in pi-mcp supplies the publishing helper; it does not load the registry extension on its own. Without the separately installed registry, MCP tools are not searchable.

## Configuration

Tools are configured via `.mcp.json` files. Configuration is merged in this order (later entries with the same server name override earlier ones):

- `<pi agent directory>/.mcp.json` — global configuration
- `<project>/.mcp.json` — project working directory
- Directories in `PI_MCP_CONFIG_DIRS` (comma-separated), each with a `.mcp.json`
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

Tool filters constrain which tools pi-mcp publishes to `search_tools`. They can specify exact tool names, or use `"*"` to allow all tools. Combining `"*"` with specific names allows read-only tools plus the explicitly named ones.

## License

MIT
