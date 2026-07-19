# pi-mcp

An MCP client extension for [pi](https://github.com/mariozechner/pi-coding-agent) that connects to Model Context Protocol (MCP) servers and loads their tools on demand.

## What it does

The extension reads `.mcp.json` configuration files (from both the agent directory and project working directory) and establishes connections to MCP servers — either via stdio (local processes) or HTTP (remote endpoints). It registers a single `mcp_search_tools` tool, which discovers matching MCP tools and loads them for the current session, prefixed with the server name (e.g., `server_toolName`).

## How it works

1. On session start, pi-mcp loads `.mcp.json` from the agent directory and project cwd (project config overrides global).
2. For each server entry, it establishes a connection via stdio or Streamable HTTP transport.
3. Use `mcp_search_tools` with plain-text server, tool, or capability keywords. Every word must match after normalizing naming conventions and common singular/plural forms; all matching tools are loaded.
4. Tool calls are forwarded to the connected MCP server and returned with content filtering (text and image only).
5. On session shutdown, all connections are cleanly closed.

## Installation

Install the extension using pi's built-in install command:

```bash
pi install git:github.com/scaryrawr/pi-mcp
```

## Configuration

Tools are configured via `.mcp.json` files. Two locations are supported (project-level overrides global):

- `~/.pi/.mcp.json` — global agent directory
- `<project>/.mcp.json` — project working directory

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
- **HTTP**: `url`, optional `headers` and `tools` filter

Tool filters constrain which tools `mcp_search_tools` can discover and load. They can specify exact tool names, or use `"*"` to allow all tools. Combining `"*"` with specific names allows read-only tools plus the explicitly named ones.

## License

MIT
