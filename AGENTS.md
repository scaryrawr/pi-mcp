# pi-mcp

MCP client extension for pi (the AI coding agent). Reads `.mcp.json` config, connects to MCP servers (stdio or HTTP), and registers available tools with pi.

## Validation

```bash
npm run build   # tsgo -p ./tsconfig.json
npm run lint    # oxlint
npm run fmt     # oxfmt (format)
npm run test    # vitest
```

Run `npm run fmt` before committing. Prefer `npm run lint` for quick checks; `npm run build` for full validation.

## Architecture

- **Single entry point**: `src/index.ts` — the pi extension factory.
- Reads `.mcp.json` from both agent directory and cwd, merging configs.
- For each server entry: establishes a connection (stdio or HTTP), fetches available tools, and registers them with pi.
- Tools are prefixed with the server name (e.g., `server_toolName`).

## Conventions

- **TypeScript**: Strict mode, `verbatimModuleSyntax`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noUncheckedSideEffectImports`.
- **TypeBox** (`@cfworker/json-schema` + `typebox`) for schema definition and compilation.
- **Named exports only** — no default imports; use `import { X } from "Y"`.
- **Tool registration**: wrap each call to `pi.registerTool` with a clear async `execute` function that forwards to `client.callTool`.
- **Type guards**: use `isDefined<T>` for narrowing `undefined` from async operations.
- **Error handling**: silently swallow config parse errors (agent should never fail to load).
- **ESM only** — `"type": "module"` in package.json.
