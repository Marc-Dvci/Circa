import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createContext } from "../../../apps/mcp-server/src/context.js";
import { createServer } from "../../../apps/mcp-server/src/server.js";

/**
 * `pnpm --silent tool <name> '<json arguments>' [--text-file <path>]`
 *
 * One MCP tool call, printed as JSON. This is the door the Agent Skill in
 * `skills/circa-quote-check/` uses: an agent with a shell and no MCP connection
 * gets the same sixteen tools Alexa+ gets, with the same schemas and the same
 * results, because the call goes to the same `McpServer` through the MCP SDK's
 * own client. The case store is the default file store, so one call's case is
 * there for the next.
 *
 * `--text-file` reads a quote document into `text`, so a document never has to
 * be escaped into a shell argument. `tool --list` prints every tool with its
 * input schema.
 */

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? argv[at + 1] : undefined;
};
const positional = argv.filter((token, i) => !token.startsWith("--") && !argv[i - 1]?.startsWith("--"));

const context = await createContext(process.env);
const server = createServer(context);
const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
await server.connect(serverSide);
const client = new Client({ name: "circa-agent-skill", version: "0.1.0" });
await client.connect(clientSide);

let exitCode = 0;
try {
  if (argv.includes("--list")) {
    const { tools } = await client.listTools();
    process.stdout.write(
      `${JSON.stringify(tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })), null, 2)}\n`,
    );
  } else {
    const [name, json] = positional;
    if (!name) throw new Error("usage: pnpm --silent tool <name> '<json arguments>' [--text-file <path>] | --list");
    const args = (json ? JSON.parse(json) : {}) as Record<string, unknown>;
    const textFile = flag("text-file");
    if (textFile) args["text"] = await readFile(textFile, "utf8");
    const result = await client.callTool({ name, arguments: args });
    const speech = ((result.content ?? []) as { type: string; text?: string }[])
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join(" ");
    process.stdout.write(
      `${JSON.stringify({ tool: name, isError: result.isError === true, speech, structuredContent: result.structuredContent ?? null }, null, 2)}\n`,
    );
    if (result.isError) exitCode = 2;
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  exitCode = 1;
} finally {
  await client.close().catch(() => undefined);
  await server.close().catch(() => undefined);
}
process.exit(exitCode);
