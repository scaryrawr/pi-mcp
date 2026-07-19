# pi-mcp Repository Guidelines

## Project Structure & Module Organization

This ESM TypeScript extension connects pi to MCP servers. `src/index.ts` is the
extension factory: it owns session lifecycle, registers the `--mcp` flag, and
coordinates the other modules. Keep MCP configuration loading and validation in
`src/mcp-config.ts`, stdio/HTTP connection lifecycle in `src/mcp-clients.ts`,
lazy discovery and pi tool registration in `src/mcp-tool-discovery.ts`, and
shared transport/configuration types in `src/mcp-types.ts`.

Configuration is merged in precedence order from the pi agent directory, the
session cwd, `PI_MCP_CONFIG_DIRS` (comma-separated), and `--mcp` JSON or file.
Server names become tool prefixes (for example, `server_toolName`). The
extension deliberately tolerates invalid or unavailable MCP configuration so it
does not prevent pi from starting; retain that behavior at these boundaries.

## Build, Test, and Development Commands

```bash
npm run lint       # Fast type-aware oxlint check for src/
npm run build      # Strict tsgo type check; emits no files
npm run test       # Vitest suite
npm run fmt:check  # Verify oxfmt output
npm run fmt        # Format before committing
```

For source changes, run `npm run build && npm run lint && npm run test`.
There is currently no narrower test command or CI workflow; add focused Vitest
coverage with new behavior where practical.

## Coding Style & Naming Conventions

Use strict TypeScript and ESM `.js` relative import specifiers. The compiler
enforces `verbatimModuleSyntax`, exact optional properties, and unchecked-index
safety; use `import type` for type-only imports. Prefer named imports and
exports; the extension factory in `src/index.ts` is the intentional default
export. Define external tool/config schemas with TypeBox and compile validators
before parsing untrusted config. Use `isDefined<T>` when filtering optional
async results rather than assertions or casts. `oxfmt` sorts imports, and
oxlint rejects explicit `any` and unused variables.

## Testing & Contribution Guidelines

Preserve tool registration semantics: dynamically loaded tools must be tracked
so session shutdown removes only tools added by this extension. Update README
configuration examples when accepted MCP sources or transport fields change.
Use concise imperative commit subjects, consistent with repository history.
