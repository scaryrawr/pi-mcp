import { constants } from "node:fs";
import { access, readFile, mkdir, realpath, stat } from "node:fs/promises";
import { validateHeaderName, validateHeaderValue } from "node:http";
import { isIP } from "node:net";
import * as path from "node:path";

import { Type } from "@earendil-works/pi-ai";
import { Compile } from "typebox/compile";

import type { McpEntry } from "./mcp-types.js";

const PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";

const MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

const namePattern = "^[a-z0-9](?:(?!.*(?:--|\\.\\.))[a-z0-9.-]{0,62}[a-z0-9])?$";

const manifestSchema = Compile(
  Type.Object(
    {
      $schema: Type.Literal(PLUGIN_SCHEMA),
      name: Type.String({ maxLength: 64, pattern: namePattern }),
      version: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
      author: Type.Optional(
        Type.Object(
          {
            name: Type.Optional(Type.String()),
            email: Type.Optional(Type.String()),
            url: Type.Optional(Type.String()),
          },
          { additionalProperties: false },
        ),
      ),
      homepage: Type.Optional(Type.String()),
      repository: Type.Optional(Type.String()),
      license: Type.Optional(Type.String()),
      keywords: Type.Optional(Type.Array(Type.String())),
      // Invalid extensions and unimplemented namespaces do not invalidate the manifest.
      extensions: Type.Optional(Type.Unknown()),
    },
    { additionalProperties: true },
  ),
);

const mcpSchema = Compile(
  Type.Object(
    {
      $schema: Type.Literal(MCP_SCHEMA),
      mcpServers: Type.Record(Type.String(), Type.Unknown()),
    },
    { additionalProperties: false },
  ),
);

const stdioSchema = Compile(
  Type.Object(
    {
      type: Type.Literal("stdio"),
      command: Type.String({ minLength: 1 }),
      args: Type.Optional(Type.Array(Type.String())),
      env: Type.Optional(Type.Record(Type.String(), Type.String())),
      cwd: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  ),
);

const extensionsSchema = Compile(Type.Record(Type.String(), Type.Unknown()));

const httpSchema = Compile(
  Type.Object(
    {
      type: Type.Literal("streamable-http"),
      url: Type.String(),
      headers: Type.Optional(Type.Record(Type.String(), Type.String())),
    },
    { additionalProperties: false },
  ),
);

function contained(root: string, target: string): boolean {
  const relative = path.relative(root, target);

  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

async function packageFile(root: string, name: string): Promise<string> {
  const file = await realpath(path.join(root, name));

  if (!contained(root, file) || !(await stat(file)).isFile())
    throw new Error(`Invalid ${name} path`);

  return file;
}

async function checkedDirectory(base: string, value: string, root: string): Promise<string> {
  const resolved = await realpath(path.resolve(base, value));

  if (!contained(root, resolved) || !(await stat(resolved)).isDirectory()) {
    throw new Error(`Invalid working directory: ${value}`);
  }

  return resolved;
}

function setEnvironmentValue(env: Record<string, string>, key: string, value: string): void {
  if (process.platform === "win32") {
    for (const existing of Object.keys(env)) {
      if (existing.toLowerCase() === key.toLowerCase()) delete env[existing];
    }
  }

  env[key] = value;
}

function expand(value: string, root: string, data: string): string {
  return value.replace(/\$\{PLUGIN_(ROOT|DATA)\}/g, (_, key: string) =>
    key === "ROOT" ? root : data,
  );
}

async function stdioEntry(
  entry: ReturnType<typeof stdioSchema.Parse>,
  root: string,
  data: string,
): Promise<McpEntry> {
  if (
    entry.env &&
    Object.keys(entry.env).some((key) =>
      process.platform === "win32"
        ? /^(PLUGIN_ROOT|PLUGIN_DATA)$/i.test(key)
        : key === "PLUGIN_ROOT" || key === "PLUGIN_DATA",
    )
  )
    throw new Error("Reserved environment variable");

  let command = entry.command;

  if (command.startsWith("./")) {
    command = await packageFile(root, command);
  } else if (
    command.includes("/") ||
    command.includes("\\") ||
    /\s/.test(command) ||
    command === "." ||
    command === ".."
  ) {
    throw new Error("Command must be a bare executable or a ./ path");
  }

  let cwd = root;

  if (entry.cwd !== undefined) {
    if (entry.cwd.startsWith("./")) {
      cwd = await checkedDirectory(root, entry.cwd, root);
    } else if (entry.cwd === "${PLUGIN_ROOT}" || entry.cwd.startsWith("${PLUGIN_ROOT}/")) {
      cwd = await checkedDirectory(root, expand(entry.cwd, root, data), root);
    } else if (entry.cwd === "${PLUGIN_DATA}" || entry.cwd.startsWith("${PLUGIN_DATA}/")) {
      cwd = await checkedDirectory(data, expand(entry.cwd, root, data), data);
    } else {
      throw new Error("Invalid working directory form");
    }
  }

  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) setEnvironmentValue(env, key, value);
  }

  for (const [key, value] of Object.entries(entry.env ?? {})) {
    setEnvironmentValue(env, key, expand(value, root, data));
  }

  setEnvironmentValue(env, "PLUGIN_ROOT", root);
  setEnvironmentValue(env, "PLUGIN_DATA", data);

  return {
    type: "local",
    command,
    args: (entry.args ?? []).map((arg) => expand(arg, root, data)),
    cwd,
    env,
  };
}

function httpEntry(entry: ReturnType<typeof httpSchema.Parse>): McpEntry {
  const url = new URL(entry.url);
  const host = url.hostname.replace(/^\[|\]$/g, "");

  const loopback =
    host === "localhost" || (isIP(host) === 4 && host.startsWith("127.")) || host === "::1";

  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    /^https?:\/\/[^/?#]*@/i.test(entry.url) ||
    entry.url.includes("#")
  ) {
    throw new Error("Invalid remote server URL");
  }

  const names = new Set<string>();

  for (const [name, val] of Object.entries(entry.headers ?? {})) {
    validateHeaderName(name);
    validateHeaderValue(name, val);

    if (names.has(name.toLowerCase())) throw new Error("Duplicate header name");
    names.add(name.toLowerCase());
  }

  const result: McpEntry = { type: "http", url: entry.url };

  if (entry.headers) result.headers = entry.headers;

  return result;
}

/** Read a v1 Agent Plugins package and map independently valid MCP servers to native entries.
 * The caller supplies a persistent, writable data directory dedicated to this installed plugin.
 */
export async function loadPluginMcp(
  rootPath: string,
  dataPath: string,
): Promise<Map<string, McpEntry>> {
  const servers = new Map<string, McpEntry>();
  const root = await realpath(rootPath);

  if (!(await stat(root)).isDirectory()) throw new Error("Plugin root must be a directory");

  const manifest: unknown = JSON.parse(
    await readFile(await packageFile(root, "plugin.json"), "utf8"),
  );

  if (!manifestSchema.Check(manifest)) throw new Error("Invalid or unsupported plugin.json");
  const plugin = manifestSchema.Parse(manifest);

  const knownFields = new Set([
    "$schema",
    "name",
    "version",
    "description",
    "author",
    "homepage",
    "repository",
    "license",
    "keywords",
    "extensions",
  ]);

  for (const key of Object.keys(plugin)) {
    if (!knownFields.has(key)) console.warn(`Ignoring unknown plugin.json field: ${key}`);
  }

  if (plugin.extensions !== undefined && !extensionsSchema.Check(plugin.extensions)) {
    console.warn("Ignoring invalid plugin.json extensions field");
  }

  let configPath: string;

  try {
    configPath = await packageFile(root, "mcp.json");
  } catch (error) {
    // SAFETY: Node filesystem errors expose an optional `code` property.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return servers;
    console.warn(`Ignoring invalid plugin MCP location: ${String(error)}`);

    return servers;
  }

  let config: unknown;

  try {
    config = JSON.parse(await readFile(configPath, "utf8"));

    if (!mcpSchema.Check(config)) throw new Error("Invalid or unsupported mcp.json");
  } catch (error) {
    console.warn(`Ignoring plugin MCP configuration: ${String(error)}`);

    return servers;
  }

  const parsed = mcpSchema.Parse(config);

  for (const [name, value] of Object.entries(parsed.mcpServers)) {
    try {
      let entry: McpEntry | undefined;

      if (stdioSchema.Check(value)) {
        // Create the data directory before launching a subprocess; preserve it across updates.
        await mkdir(dataPath, { recursive: true });
        const data = await realpath(dataPath);

        if (!(await stat(data)).isDirectory()) throw new Error("PLUGIN_DATA must be a directory");
        await access(data, constants.W_OK);
        entry = await stdioEntry(stdioSchema.Parse(value), root, data);
      } else if (httpSchema.Check(value)) {
        entry = httpEntry(httpSchema.Parse(value));
      }

      if (!entry) throw new Error("Unsupported or invalid server entry");
      servers.set(`${plugin.name}_${name}`, entry);
    } catch (error) {
      console.warn(`Skipping plugin MCP server ${name}: ${String(error)}`);
    }
  }

  return servers;
}
