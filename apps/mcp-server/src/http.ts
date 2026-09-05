import { randomUUID } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import express, { type Express } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { ServerContext } from "./context.js";
import { createServer, REQUIRED_PROTOCOL_VERSION, SDK_PROTOCOL_VERSION, SERVER_NAME, SERVER_VERSION } from "./server.js";
import { DemoAuthorizationServer, oauthRouter, requireBearer, type OAuthConfig } from "./oauth.js";
import { TOOL_NAMES } from "./tools.js";
import { VIEWS } from "./ui/views.js";

/**
 * Streamable HTTP, which is the only transport Alexa+ accepts.
 *
 * Stateful: a session id is issued on `initialize` and every later request
 * carries it. Stateless would have been less code, and it would also have meant
 * a new `McpServer` per request — which is fine until the first
 * `notifications/tools/list_changed`, and a repair conversation that spans a
 * fortnight is exactly the case where a server wants to be able to say something
 * without being asked.
 *
 * One transport per session, one `McpServer` per transport, and both are torn
 * down together. The map is the leak risk, so `onsessionclosed` removes the
 * entry rather than leaving it for a sweep that does not exist yet.
 */

export interface HttpOptions {
  port?: number;
  /** Public origin, used for OAuth metadata. Defaults to http://localhost:<port>. */
  publicUrl?: string;
  auth?: boolean;
  path?: string;
}

export interface RunningServer {
  app: Express;
  http: HttpServer;
  port: number;
  url: string;
  close: () => Promise<void>;
}

interface Session {
  transport: StreamableHTTPServerTransport;
  close: () => Promise<void>;
}

export function createApp(context: ServerContext, options: HttpOptions = {}): { app: Express; sessions: Map<string, Session>; closeAll: () => Promise<void> } {
  const app = express();
  const mcpPath = options.path ?? "/mcp";
  const sessions = new Map<string, Session>();

  app.use(express.json({ limit: "2mb" }));

  if (options.auth) {
    const issuer = options.publicUrl ?? `http://localhost:${options.port ?? 8787}`;
    const config: OAuthConfig = {
      issuer,
      resource: `${issuer}${mcpPath}`,
      redirectUris: [
        "https://layla.amazon.com/api/skill/link/circa",
        "https://pitangui.amazon.com/api/skill/link/circa",
        "https://alexa.amazon.co.jp/api/skill/link/circa",
        "http://localhost:8788/callback",
      ],
      clientId: "circa-alexa-addon",
    };
    const authServer = new DemoAuthorizationServer(config);
    app.use(oauthRouter(authServer, config));
    app.use(mcpPath, requireBearer(authServer, config));
    (app as Express & { authServer?: DemoAuthorizationServer }).authServer = authServer;
  }

  /**
   * Health, and what it is honest about.
   *
   * It reports the protocol version the SDK will negotiate and the one Alexa+
   * requires as two separate fields, because a health endpoint that folded them
   * into `"ok": true` would be green on the day the SDK's default moves.
   */
  app.get("/health", (_req, res) => {
    res.json({
      name: SERVER_NAME,
      version: SERVER_VERSION,
      protocolVersion: SDK_PROTOCOL_VERSION,
      requiredByAlexa: REQUIRED_PROTOCOL_VERSION,
      protocolOk: SDK_PROTOCOL_VERSION >= REQUIRED_PROTOCOL_VERSION,
      transport: "streamable-http",
      tools: TOOL_NAMES.length,
      views: VIEWS.length,
      store: context.service.describe(),
      providers: context.providers.describe(),
      sessions: sessions.size,
      uptimeSeconds: Math.round(process.uptime()),
    });
  });

  app.get("/metrics", (_req, res) => {
    res.json({ tools: context.metrics.summary(), calls: context.metrics.all().length });
  });

  app.post(mcpPath, async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const existing = sessionId ? sessions.get(sessionId) : undefined;

    if (existing) {
      await existing.transport.handleRequest(req, res, req.body);
      return;
    }

    if (!isInitializeRequest(req.body)) {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "No valid session. Send an initialize request first." },
        id: null,
      });
      return;
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, close: () => server.close() });
      },
      onsessionclosed: async (id) => {
        sessions.delete(id);
        await server.close();
      },
    });
    const server = createServer(context);
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  // GET opens the server-to-client stream; DELETE ends the session. Both are
  // part of Streamable HTTP rather than optional extras, and a server that only
  // answers POST is a server that cannot send a notification.
  const bySession = async (req: express.Request, res: express.Response): Promise<void> => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (!session) {
      res.status(400).send("Unknown or missing session id");
      return;
    }
    await session.transport.handleRequest(req, res);
  };
  app.get(mcpPath, bySession);
  app.delete(mcpPath, bySession);

  const closeAll = async (): Promise<void> => {
    for (const [id, session] of sessions) {
      sessions.delete(id);
      await session.transport.close().catch(() => undefined);
      await session.close().catch(() => undefined);
    }
  };

  return { app, sessions, closeAll };
}

export async function startHttpServer(context: ServerContext, options: HttpOptions = {}): Promise<RunningServer> {
  const { app, closeAll } = createApp(context, options);
  const requested = options.port ?? 8787;
  const http = await new Promise<HttpServer>((resolve, reject) => {
    const server = app.listen(requested, () => resolve(server));
    server.on("error", reject);
  });
  const address = http.address();
  const port = typeof address === "object" && address ? address.port : requested;
  return {
    app,
    http,
    port,
    url: `http://localhost:${port}`,
    close: async () => {
      await closeAll();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
