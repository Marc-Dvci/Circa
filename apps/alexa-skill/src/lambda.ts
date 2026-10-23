import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CaseService, configureRepository, type CaseRepository } from "#store";
import { DemoProviderRepository } from "#providers";
import { createContext } from "../../mcp-server/src/context.js";
import { createServer } from "../../mcp-server/src/server.js";
import { CircaSkill, pointerFrom, type AlexaRequestEnvelope, type AlexaResponseEnvelope, type ToolTrace } from "./skill.js";

/**
 * The AWS Lambda behind the classic custom skill.
 *
 * Each request builds the same `McpServer` the Streamable HTTP endpoint serves,
 * with the same sixteen tools, and connects the MCP SDK's own `Client` to it
 * over an in-memory transport. The skill is therefore an MCP host like the
 * simulator, and the server cannot tell it from Alexa+ except by the client
 * name it announces. The case store is DynamoDB (`CIRCA_STORE=dynamodb`), so a
 * repair opened in one conversation is there in the next.
 *
 * The repository and the provider directory are built once per container. The
 * server and the client are built per request, because the user is per request.
 */

let repository: Promise<CaseRepository> | undefined;
let providers: DemoProviderRepository | undefined;

/** Alexa's user id is long and is the customer's identifier with Amazon; the case store keeps a digest of it. */
export function circaUserId(alexaUserId: string): string {
  return `alexa_${createHash("sha256").update(alexaUserId).digest("hex").slice(0, 24)}`;
}

export interface Connected {
  client: Client;
  close: () => Promise<void>;
}

/** The MCP server, in-process, with the SDK client connected to it. */
export async function connect(
  userId: string,
  options: { repository?: CaseRepository; providers?: DemoProviderRepository; env?: NodeJS.ProcessEnv } = {},
): Promise<Connected> {
  const env = options.env ?? process.env;
  repository ??= configureRepository(env);
  // Bundled for Lambda, the directory ships beside the handler and CIRCA_PROVIDERS names it.
  providers ??= env["CIRCA_PROVIDERS"] ? new DemoProviderRepository(env["CIRCA_PROVIDERS"]) : new DemoProviderRepository();
  const context = await createContext(env, {
    service: new CaseService(options.repository ?? (await repository)),
    providers: options.providers ?? providers,
    userId,
    uploads: undefined,
  });
  const server = createServer(context);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "circa-alexa-skill", version: "0.1.0" });
  await client.connect(clientSide);
  return {
    client,
    close: async () => {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    },
  };
}

export async function handleEnvelope(
  envelope: AlexaRequestEnvelope,
  open: (userId: string) => Promise<Connected>,
): Promise<{ response: AlexaResponseEnvelope; calls: ToolTrace[] }> {
  const alexaUser = envelope.session?.user?.userId ?? envelope.context?.System?.user?.userId;
  if (!alexaUser) throw new Error("the request carries no user");
  const connected = await open(circaUserId(alexaUser));
  try {
    return await new CircaSkill(connected.client, pointerFrom(envelope)).handle(envelope);
  } finally {
    await connected.close();
  }
}

export const handler = async (envelope: AlexaRequestEnvelope): Promise<AlexaResponseEnvelope> => {
  // The Lambda trigger already checks the skill id; this check keeps the
  // function from answering any other skill if the trigger is ever loosened.
  const expected = process.env["CIRCA_SKILL_ID"];
  const applicationId = envelope.session?.application?.applicationId ?? envelope.context?.System?.application?.applicationId;
  if (expected && applicationId !== expected) throw new Error("request for a different skill");

  const started = performance.now();
  const { response, calls } = await handleEnvelope(envelope, (userId) => connect(userId));
  // One line per turn in CloudWatch: what Alexa resolved and which tools ran.
  console.log(
    JSON.stringify({
      request: envelope.request.type,
      intent: envelope.request.intent?.name,
      tools: calls.map((c) => `${c.read ? "~" : ""}${c.tool}${c.isError ? "!" : ""}`),
      ms: Math.round(performance.now() - started),
    }),
  );
  return response;
};
