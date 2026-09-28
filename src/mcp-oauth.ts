import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";

import { Type } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  Client,
  StreamableHTTPClientTransport,
  type OAuthClientInformationContext,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
  type StreamableHTTPClientTransportOptions,
} from "@modelcontextprotocol/client";
import { Compile } from "typebox/compile";

import type { HttpMcpEntry } from "./mcp-types.js";

const CredentialsSchema = Compile(
  Type.Object({
    clients: Type.Optional(Type.Record(Type.String(), Type.Object({ client_id: Type.String() }))),
    tokens: Type.Optional(Type.Record(Type.String(), Type.Object({ access_token: Type.String() }))),
    verifier: Type.Optional(Type.String()),
    state: Type.Optional(Type.String()),
    discovery: Type.Optional(Type.Object({ authorizationServerUrl: Type.String() })),
  }),
);

type Credentials = {
  clients?: Record<string, StoredOAuthClientInformation>;
  tokens?: Record<string, StoredOAuthTokens>;
  verifier?: string;
  state?: string;
  discovery?: OAuthDiscoveryState;
};

/** Keep credentials outside project config and session transcripts. */
export class McpOAuthProvider implements OAuthClientProvider {
  readonly redirectUrl: string;
  readonly clientMetadataUrl?: string;
  readonly clientMetadata: OAuthClientMetadata;
  private readonly file: string;
  private readonly staticClientId?: string;
  private readonly credentials: Credentials;
  private authorizationUrl?: URL;

  private constructor(
    name: string,
    entry: HttpMcpEntry,
    redirectUrl: string,
    credentials: Credentials,
  ) {
    this.redirectUrl = redirectUrl;
    this.file = credentialFile(name, entry.url);
    this.credentials = credentials;

    if (entry.oauth?.clientId) this.staticClientId = entry.oauth.clientId;

    if (entry.oauth?.clientMetadataUrl) this.clientMetadataUrl = entry.oauth.clientMetadataUrl;
    this.clientMetadata = {
      client_name: "pi-mcp",
      redirect_uris: [redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  static async create(
    name: string,
    entry: HttpMcpEntry,
    redirectUrl: string,
  ): Promise<McpOAuthProvider> {
    let credentials: Credentials = {};

    try {
      const parsed: unknown = JSON.parse(await readFile(credentialFile(name, entry.url), "utf8"));

      if (CredentialsSchema.Check(parsed)) {
        // SAFETY: The validated credential fields are written by persist() from SDK credential types.
        credentials = parsed as Credentials;
      }
    } catch {
      // No credentials yet, or corrupt credentials. Login can replace them.
    }

    return new McpOAuthProvider(name, entry, redirectUrl, credentials);
  }

  hasTokens(): boolean {
    return Object.keys(this.credentials.tokens ?? {}).length > 0;
  }

  state(): string {
    const state = randomBytes(32).toString("hex");
    this.credentials.state = state;

    return state;
  }

  clientInformation(ctx?: OAuthClientInformationContext): StoredOAuthClientInformation | undefined {
    if (this.staticClientId) return { client_id: this.staticClientId };

    return ctx ? this.credentials.clients?.[ctx.issuer] : this.credentials.clients?.[""];
  }

  async saveClientInformation(
    info: StoredOAuthClientInformation,
    ctx?: OAuthClientInformationContext,
  ): Promise<void> {
    (this.credentials.clients ??= {})[ctx?.issuer ?? ""] = info;
    this.credentials.clients[""] = info;
    await this.persist();
  }

  tokens(ctx?: OAuthClientInformationContext): StoredOAuthTokens | undefined {
    return this.credentials.tokens?.[ctx?.issuer ?? ""];
  }

  async saveTokens(tokens: StoredOAuthTokens, ctx?: OAuthClientInformationContext): Promise<void> {
    (this.credentials.tokens ??= {})[ctx?.issuer ?? ""] = tokens;
    // The transport calls tokens() without an issuer for each request.
    this.credentials.tokens[""] = tokens;
    await this.persist();
  }

  redirectToAuthorization(url: URL): void {
    this.authorizationUrl = url;
  }

  getAuthorizationUrl(): URL | undefined {
    return this.authorizationUrl;
  }

  validState(state: string | null): boolean {
    return !!state && state === this.credentials.state;
  }

  async saveCodeVerifier(verifier: string): Promise<void> {
    this.credentials.verifier = verifier;
    await this.persist();
  }

  codeVerifier(): string {
    if (!this.credentials.verifier) throw new Error("Missing OAuth code verifier");

    return this.credentials.verifier;
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    this.credentials.discovery = state;
    await this.persist();
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.credentials.discovery;
  }

  private async persist(): Promise<void> {
    const dir = join(getAgentDir(), "mcp-oauth");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${randomBytes(8).toString("hex")}.tmp`;
    await writeFile(temp, JSON.stringify(this.credentials), { mode: 0o600, flag: "wx" });
    await chmod(temp, 0o600);
    await rename(temp, this.file);
  }
}

function credentialFile(name: string, url: string): string {
  const id = createHash("sha256")
    .update(JSON.stringify([name, url]))
    .digest("hex");

  return join(getAgentDir(), "mcp-oauth", `${id}.json`);
}

/** Run an explicit PKCE login on a loopback callback; never block session startup. */
export async function loginMcp(
  name: string,
  entry: HttpMcpEntry,
  ctx: ExtensionCommandContext,
): Promise<void> {
  if (!ctx.hasUI) throw new Error("OAuth login requires an interactive UI");

  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(entry.oauth?.port ?? 8765, "127.0.0.1", resolve);
  });
  const redirectUrl = `http://127.0.0.1:${entry.oauth?.port ?? 8765}/callback`;
  const client = new Client({ name: `pi-mcp-${name}`, version: "1.0.0" });

  try {
    const provider = await McpOAuthProvider.create(name, entry, redirectUrl);
    const options: StreamableHTTPClientTransportOptions = { authProvider: provider };

    if (entry.headers) options.requestInit = { headers: entry.headers };

    const transport = new StreamableHTTPClientTransport(new URL(entry.url), options);

    try {
      await client.connect(transport);

      if (provider.hasTokens()) return;
    } catch {
      // The SDK starts authorization on the initial 401.
    }

    const url = provider.getAuthorizationUrl();

    if (!url) throw new Error("Server did not offer OAuth authorization; check its configuration");

    const callback = new Promise<URLSearchParams>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("OAuth login timed out")), 5 * 60_000);
      server.on("request", (req, res) => {
        const requestUrl = new URL(req.url ?? "/", redirectUrl);

        if (requestUrl.pathname !== "/callback" || req.headers.host !== new URL(redirectUrl).host) {
          res.writeHead(404).end();

          return;
        }

        if (!provider.validState(requestUrl.searchParams.get("state"))) {
          res.writeHead(400).end("Invalid OAuth state");

          return;
        }

        clearTimeout(timer);
        res
          .writeHead(200, { "Content-Type": "text/plain" })
          .end("Authorization received. You can return to pi.");
        resolve(requestUrl.searchParams);
      });
    });

    ctx.ui.notify(`Authorize ${name} in your browser: ${url.toString()}`, "info");

    // RPC clients may be remote; give them the URL without opening a browser on the host.
    if (ctx.mode === "tui") {
      const opener =
        process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";

      const args =
        process.platform === "win32" ? ["/c", "start", "", url.toString()] : [url.toString()];

      void import("node:child_process").then(({ spawn }) => {
        const child = spawn(opener, args, { stdio: "ignore", detached: true });
        child.on("error", () => {});
        child.unref();
      });
    }

    const params = await callback;
    await transport.finishAuth(params);
  } finally {
    server.close();
    await client.close().catch(() => {});
  }
}
