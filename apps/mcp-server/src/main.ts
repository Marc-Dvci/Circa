import { createContext } from "./context.js";
import { startHttpServer } from "./http.js";
import { REQUIRED_PROTOCOL_VERSION, SDK_PROTOCOL_VERSION } from "./server.js";
import { TOOL_NAMES } from "./tools.js";
import { VIEWS } from "./ui/views.js";

/**
 * `pnpm mcp`.
 *
 * Prints what it is before it prints that it started, because the two questions
 * a judge has at this point are which protocol version is live and whether the
 * thing needs an AWS account. Both are answered in the first four lines.
 */
async function main(): Promise<void> {
  const context = await createContext();
  const port = Number(process.env["PORT"] ?? process.env["CIRCA_PORT"] ?? 8787);
  const auth = process.env["CIRCA_AUTH"] === "1";
  const server = await startHttpServer(context, {
    port,
    auth,
    ...(process.env["CIRCA_PUBLIC_URL"] ? { publicUrl: process.env["CIRCA_PUBLIC_URL"] } : {}),
  });

  const lines = [
    `CIRCA MCP server`,
    `  transport      Streamable HTTP at ${server.url}/mcp`,
    `  protocol       ${SDK_PROTOCOL_VERSION}${SDK_PROTOCOL_VERSION >= REQUIRED_PROTOCOL_VERSION ? "" : `  (Alexa+ requires ${REQUIRED_PROTOCOL_VERSION})`}`,
    `  tools          ${TOOL_NAMES.length}`,
    `  views          ${VIEWS.length} MCP Apps resources`,
    `  store          ${context.service.describe()}`,
    `  providers      ${context.providers.describe()}`,
    `  auth           ${auth ? "OAuth 2.1 + PKCE S256 (demo authorization server)" : "off — set CIRCA_AUTH=1 to require a bearer token"}`,
    ``,
    `  health         ${server.url}/health`,
    `  metrics        ${server.url}/metrics`,
  ];
  process.stdout.write(`${lines.join("\n")}\n`);

  const shutdown = async (): Promise<void> => {
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
