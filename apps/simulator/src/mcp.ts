import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/**
 * The connection, made the way Alexa+ makes it.
 *
 * The MCP SDK's own `Client` and its own `StreamableHTTPClientTransport`,
 * running in the browser against `/mcp` on this origin — the dev server proxies
 * that to the CIRCA process, so what leaves the page is a genuine Streamable
 * HTTP `initialize`, and what comes back is a negotiated protocol version this
 * page did not choose. It is displayed in the status bar for exactly that
 * reason: a simulator that printed `2025-11-25` from a constant would be
 * decoration.
 *
 * Views are fetched with `resources/read` and cached. That is also how a real
 * host does it — the view is a resource on the MCP connection, not a file this
 * app ships — which is why the simulator has no copy of any card's markup.
 */

export interface Connection {
  client: Client;
  protocolVersion: string;
  sessionId: string | undefined;
  serverName: string;
  toolCount: number;
  viewCount: number;
}

export async function connect(): Promise<Connection> {
  const transport = new StreamableHTTPClientTransport(new URL("/mcp", window.location.origin));
  const client = new Client({ name: "alexa-plus-simulator", version: "0.1.0" });
  await client.connect(transport);
  const { tools } = await client.listTools();
  const { resources } = await client.listResources();
  return {
    client,
    protocolVersion: transport.protocolVersion ?? "unknown",
    sessionId: transport.sessionId,
    serverName: client.getServerVersion()?.name ?? "unknown",
    toolCount: tools.length,
    viewCount: resources.length,
  };
}

const views = new Map<string, string>();

/** Read a view resource once and keep it. `text/html;profile=mcp-app`, served over the MCP connection. */
export async function readView(client: Client, uri: string): Promise<string> {
  const cached = views.get(uri);
  if (cached) return cached;
  const result = await client.readResource({ uri });
  const first = result.contents[0] as { text?: string; mimeType?: string } | undefined;
  const html = first?.text ?? "";
  if (!html) throw new Error(`view ${uri} came back empty`);
  views.set(uri, html);
  return html;
}

/** The view a tool result names, via the nested `_meta.ui.resourceUri`. */
export function viewUriOf(result: unknown): string | undefined {
  const meta = (result as { _meta?: { ui?: { resourceUri?: string } } })._meta;
  return meta?.ui?.resourceUri;
}
