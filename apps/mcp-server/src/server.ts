import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import type { ServerContext } from "./context.js";
import { registerTools } from "./tools.js";
import { UI_MIME_TYPE, VIEWS, viewHtml, viewMeta } from "./ui/views.js";

export const SERVER_NAME = "circa";
export const SERVER_VERSION = "0.1.0";

/**
 * The protocol version this server is built against.
 *
 * Alexa+ requires 2025-11-25 or later, and this is asserted rather than assumed:
 * `tests/mcp-conformance.test.ts` connects a real `StreamableHTTPClientTransport`
 * over a real socket and checks the version the two sides actually negotiated.
 * A hand-rolled client agreeing with a hand-rolled server is not evidence of
 * anything, which is a lesson this project inherited rather than learned.
 */
export const REQUIRED_PROTOCOL_VERSION = "2025-11-25";
export const SDK_PROTOCOL_VERSION = LATEST_PROTOCOL_VERSION;

const INSTRUCTIONS = `CIRCA keeps the record of a home repair a customer is deciding about, and checks what can be checked before money moves.

Three things to know before using these tools.

It does not issue trust verdicts. It reports what is and is not established about a transaction, each item citing published consumer guidance. There is no score. If the customer asks whether a contractor is trustworthy, say plainly that this cannot be answered, then give them the checklist.

An unanswered question is not a finding. Only pass a field to answer_verification_question when the customer actually answered it.

Comparisons often refuse. Most residential quotes are one price for a paragraph of work, so compare_quotes will frequently report that it cannot say where the difference sits. That refusal, and the sentence about what would make it answerable, is the answer. Do not fill the gap with an estimate.

Money crosses this boundary in dollars.`;

export function createServer(context: ServerContext): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION, title: "CIRCA — repair transaction guardian" },
    {
      capabilities: {
        tools: {},
        resources: {},
        // MCP Apps (SEP-1865). Declaring the extension is how the host learns
        // that tool results carry a view; a host that does not understand it
        // ignores the key and still gets a complete spoken answer, which is the
        // property that keeps voice-only a first-class path.
        extensions: {
          "io.modelcontextprotocol/ui": { mimeTypes: [UI_MIME_TYPE] },
        },
      },
      instructions: INSTRUCTIONS,
    },
  );

  for (const view of VIEWS) {
    server.registerResource(
      view.name,
      view.uri,
      {
        title: view.title,
        description: view.description,
        mimeType: UI_MIME_TYPE,
        _meta: viewMeta(view),
      },
      async (uri) => ({
        contents: [
          {
            uri: uri.href,
            mimeType: UI_MIME_TYPE,
            text: viewHtml(view),
            _meta: viewMeta(view),
          },
        ],
      }),
    );
  }

  registerTools(server, context);
  return server;
}
