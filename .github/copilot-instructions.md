# pi-mcp — Copilot Instructions

## Quick start

1. **Validate**: `npm run build && npm run lint` before finishing work.
2. **Format**: `npm run fmt` before committing.
3. **Test**: `npm run test` (vitest) — add tests when adding logic.

## Repo structure

- `src/index.ts` — the only source file; this is the pi extension entry point.
- `.oxlintrc.json` — oxlint config (strict correctness + no-explicit-any).
- `.oxfmtrc.json` — oxfmt config.
- `tsconfig.json` — strict TS config.

## Copilot tips

- The extension exports a **default function** receiving `pi: ExtensionAPI`. Tools are registered via `pi.registerTool`.
- When adding new tool wrappers, follow the pattern in `src/index.ts`: define parameters with TypeBox, then wrap with `pi.registerTool`.
- MCP config schema lives in `src/index.ts` (`mcpSchema`). New config options should update this schema.
- Use `isDefined<T>` type guard for narrowing results from async operations.
