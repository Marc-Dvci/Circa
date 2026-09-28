import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { DemoProviderRepository } from "#providers";
import { createContext } from "../../../apps/mcp-server/src/context.js";
import { startHttpServer } from "../../../apps/mcp-server/src/http.js";
import { INDEPENDENT_QUOTE, ITEMISED_REQUOTE } from "./script.js";

/**
 * `pnpm upload:check`: an uploaded quote, end to end, against AWS.
 *
 * The demo's payoff, with the itemised re-quote arriving as an upload instead
 * of typed text. The document is put in the S3 bucket `CIRCA_BUCKET` names,
 * under the user's upload prefix; `add_quote` receives only its key, over the
 * MCP SDK's own client on a real socket; the server reads the object back from
 * S3 and the same parser as the typed path itemises it. `compare_quotes` must
 * then give the answer the typed demo gives, figure for figure, and a key under
 * another user's prefix must be refused, or the script exits non-zero.
 *
 * With `CIRCA_TEXTRACT=1` the upload is a PNG of the quote and Textract reads
 * it; otherwise it is the quote as a text file, as a forwarded email would be.
 *
 *   CIRCA_BUCKET=<bucket> AWS_REGION=us-east-1 pnpm upload:check
 *   CIRCA_BUCKET=<bucket> CIRCA_TEXTRACT=1 AWS_REGION=us-east-1 pnpm upload:check
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const PHOTO = path.join(REPO_ROOT, "fixtures/documents/apex-revised-estimate-4471.png");
const EXPECTED = ["$4,030", "$420", "$200", "Seal penetrations"];

type Result = { content?: { type: string; text?: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

const say = (label: string, value: string): void => {
  process.stdout.write(`  ${label.padEnd(26)}${value}\n`);
};

async function main(): Promise<void> {
  if (!process.env["CIRCA_BUCKET"]) throw new Error("set CIRCA_BUCKET to the documents bucket");
  const photo = process.env["CIRCA_TEXTRACT"] === "1";

  const context = await createContext(process.env, { providers: new DemoProviderRepository() });
  if (!context.uploads) throw new Error("uploads did not configure");
  const server = await startHttpServer(context, { port: 0 });
  const client = new Client({ name: "circa-upload-check", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`));

  const call = async (name: string, args: Record<string, unknown>): Promise<Result & { ms: number }> => {
    const started = performance.now();
    const result = (await client.callTool({ name, arguments: args })) as Result;
    const ms = Math.round(performance.now() - started);
    if (result.isError) throw new Error(`${name}: ${result.content?.[0]?.text ?? "error"}`);
    return { ...result, ms };
  };

  try {
    await client.connect(transport);
    process.stdout.write(`\nCIRCA: an uploaded quote, through S3${photo ? " and Textract" : ""}\n\n`);
    say("bucket", context.uploads.bucket);
    say("protocol", transport.protocolVersion ?? "unknown");

    const bytes = photo ? new Uint8Array(await readFile(PHOTO)) : new TextEncoder().encode(ITEMISED_REQUOTE);
    const started = performance.now();
    const key = await context.uploads.put(context.userId, bytes, photo ? "image/png" : "text/plain");
    say("s3 PutObject", `${key} (${Math.round(bytes.byteLength / 1024)} KB, ${Math.round(performance.now() - started)} ms)`);

    const opened = await call("start_repair_case", {
      issueSummary: "A roofer says the chimney flashing has failed and water could get in tonight",
      trade: "roofing",
      postalCode: "02139",
    });
    const caseId = String(opened.structuredContent?.["caseId"]);

    const independent = await call("add_quote", {
      caseId,
      contractorName: "Nine Elms Exterior Surveys",
      source: "SECOND_OPINION",
      text: INDEPENDENT_QUOTE,
    });
    const quoteB = String(independent.structuredContent?.["quoteId"]);

    const uploaded = await call("add_quote", {
      caseId,
      contractorName: "Apex Exteriors",
      source: "CONTRACTOR",
      documentKey: key,
    });
    const quoteApex = String(uploaded.structuredContent?.["quoteId"]);
    say("add_quote from the upload", `${uploaded.ms} ms (S3 GetObject + ${photo ? "Textract + " : ""}parser)`);
    say("  it said", `“${uploaded.content?.[0]?.text ?? ""}”`);

    const compared = await call("compare_quotes", { caseId, quoteAId: quoteApex, quoteBId: quoteB });
    const speech = compared.content?.[0]?.text ?? "";
    say("compare_quotes", `${compared.ms} ms`);
    say("  it said", `“${speech}”`);

    const missing = EXPECTED.filter((figure) => !speech.includes(figure));
    say("same answer as typed text", missing.length === 0 ? "yes" : `no, missing ${missing.join(", ")}`);

    const foreign = (await client.callTool({
      name: "add_quote",
      arguments: { caseId, documentKey: `uploads/someone_else/${key.split("/").at(-1)}` },
    })) as Result;
    say("another user's key", foreign.isError ? `refused: “${foreign.content?.[0]?.text ?? ""}”` : "ACCEPTED");

    process.stdout.write("\n");
    if (missing.length > 0 || !foreign.isError) process.exitCode = 1;
  } finally {
    await client.close().catch(() => undefined);
    await server.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
