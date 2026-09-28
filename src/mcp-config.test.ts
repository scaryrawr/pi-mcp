import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { loadMcpConfig } from "./mcp-config.js";

function loadConfig(cwd: string, flag?: string) {
  // SAFETY: The API stub supplies the getFlag method used by loadMcpConfig.
  const pi = { getFlag: () => flag } as Pick<ExtensionAPI, "getFlag">;
  // SAFETY: loadMcpConfig only reads cwd from the context.
  const ctx = { cwd } as ExtensionContext;

  // SAFETY: loadMcpConfig only reads getFlag from the API.
  return loadMcpConfig(pi as ExtensionAPI, ctx);
}

describe("MCP configuration files", () => {
  it("loads both filenames in a directory, with .mcp.json taking precedence", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-mcp-config-"));
    const plain = { command: "plain", args: [] };
    const hidden = { command: "hidden", args: [] };

    try {
      await writeFile(join(cwd, "mcp.json"), JSON.stringify({ plain, shared: plain }));
      await writeFile(
        join(cwd, ".mcp.json"),
        JSON.stringify({ servers: { hidden, shared: hidden } }),
      );

      const config = await loadConfig(cwd);

      expect(config).toMatchObject({ plain, hidden, shared: hidden });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it.each(["servers", "mcpServers"] as const)(
    "loads the %s wrapper from a configuration file",
    async (wrapper) => {
      const cwd = await mkdtemp(join(tmpdir(), "pi-mcp-config-"));
      const entry = { command: "wrapped", args: [] };

      try {
        await writeFile(join(cwd, "mcp.json"), JSON.stringify({ [wrapper]: { wrapped: entry } }));
        expect(await loadConfig(cwd)).toMatchObject({ wrapped: entry });
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    },
  );

  it.each(["servers", "mcpServers"] as const)(
    "loads the %s wrapper from inline --mcp and overrides file entries",
    async (wrapper) => {
      const cwd = await mkdtemp(join(tmpdir(), "pi-mcp-config-"));
      const fileEntry = { command: "file", args: [] };
      const flagEntry = { command: "flag", args: [] };

      try {
        await writeFile(join(cwd, "mcp.json"), JSON.stringify({ shared: fileEntry }));
        expect(
          await loadConfig(cwd, JSON.stringify({ [wrapper]: { shared: flagEntry } })),
        ).toMatchObject({
          shared: flagEntry,
        });
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    },
  );

  it("loads a wrapped --mcp file", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-mcp-config-"));
    const entry = { command: "flag-file", args: [] };
    const flagFile = join(cwd, "flag.json");

    try {
      await writeFile(flagFile, JSON.stringify({ mcpServers: { flagFileServer: entry } }));
      expect(await loadConfig(cwd, flagFile)).toMatchObject({ flagFileServer: entry });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("ignores malformed wrapped configurations without losing valid sources", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-mcp-config-"));
    const entry = { command: "valid", args: [] };

    try {
      await writeFile(join(cwd, "mcp.json"), JSON.stringify({ valid: entry }));
      await writeFile(join(cwd, ".mcp.json"), JSON.stringify({ servers: { bad: { args: [] } } }));

      expect(
        await loadConfig(cwd, JSON.stringify({ mcpServers: { bad: { args: [] } } })),
      ).toMatchObject({ valid: entry });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("accepts HTTP OAuth options and rejects invalid ports", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-mcp-config-"));

    try {
      const entry = {
        type: "http",
        url: "https://mcp.example.com/mcp",
        oauth: { clientId: "public-client", port: 8765 },
      };

      expect(await loadConfig(cwd, JSON.stringify({ remote: entry }))).toMatchObject({
        remote: entry,
      });
      expect(
        await loadConfig(cwd, JSON.stringify({ remote: { ...entry, oauth: { port: 0 } } })),
      ).toEqual({});
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("keeps a flat server named servers", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-mcp-config-"));
    const entry = { command: "flat", args: [] };

    try {
      await writeFile(join(cwd, "mcp.json"), JSON.stringify({ servers: entry }));
      expect(await loadConfig(cwd)).toMatchObject({ servers: entry });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
