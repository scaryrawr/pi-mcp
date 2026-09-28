import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { loadMcpConfig } from "./mcp-config.js";

describe("MCP configuration files", () => {
  it("loads both filenames in a directory, with .mcp.json taking precedence", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-mcp-config-"));
    const plain = { command: "plain", args: [] };
    const hidden = { command: "hidden", args: [] };

    try {
      await writeFile(join(cwd, "mcp.json"), JSON.stringify({ plain, shared: plain }));
      await writeFile(join(cwd, ".mcp.json"), JSON.stringify({ hidden, shared: hidden }));

      // SAFETY: The API stub supplies the getFlag method used by loadMcpConfig.
      const pi = { getFlag: () => undefined } as Pick<ExtensionAPI, "getFlag">;
      // SAFETY: loadMcpConfig only reads cwd from the context.
      const ctx = { cwd } as ExtensionContext;
      // SAFETY: loadMcpConfig only reads getFlag from the API.
      const config = await loadMcpConfig(pi as ExtensionAPI, ctx);

      expect(config).toMatchObject({ plain, hidden, shared: hidden });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
