import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { configureRepository } from "#store";
import { CaseService } from "#store";
import { DemoProviderRepository } from "#providers";
import { createContext } from "../../../apps/mcp-server/src/context.js";
import { startHttpServer } from "../../../apps/mcp-server/src/http.js";
import { REQUIRED_PROTOCOL_VERSION, SDK_PROTOCOL_VERSION } from "../../../apps/mcp-server/src/server.js";
import { TOOL_NAMES } from "../../../apps/mcp-server/src/tools.js";
import { VIEWS } from "../../../apps/mcp-server/src/ui/views.js";

/**
 * `pnpm doctor`.
 *
 * What is actually live, checked rather than described. Every optional path in
 * this product is off by default and turned on by an environment variable, which
 * is the right default and also the reason a person cannot tell by looking
 * whether the thing in front of them is talking to AWS. So this asks each one.
 *
 * The rule it follows: **never report a capability from the presence of a flag.**
 * `CIRCA_STORE=dynamodb` says what was asked for; whether a table answers is a
 * different question, and the two are printed as separate lines. The same for
 * credentials — a key in the environment is not a credential that resolves, and
 * both sibling projects in this hackathon found that out from a live API rather
 * than from a config file.
 */

const BOLD = "[1m";
const DIM = "[2m";
const YELLOW = "[33m";
const RESET = "[0m";

const colour = process.stdout.isTTY && !process.env["NO_COLOR"];
const c = (code: string, text: string): string => (colour ? `${code}${text}${RESET}` : text);

type Verdict = "ok" | "off" | "warn";

interface Line {
  label: string;
  value: string;
  verdict: Verdict;
  note?: string;
}

const MARK: Record<Verdict, string> = { ok: "·", off: "–", warn: "!" };

function line(label: string, value: string, verdict: Verdict = "ok", note?: string): Line {
  return { label, value, verdict, ...(note ? { note } : {}) };
}

/** A promise with a deadline. The AWS credential chain can reach for instance metadata that is not there. */
async function within<T>(ms: number, work: Promise<T>): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

async function corpusSize(relative: string, key?: string): Promise<number> {
  const raw = JSON.parse(await readFile(path.join(REPO_ROOT, relative), "utf8")) as unknown;
  const list = Array.isArray(raw) ? raw : ((raw as Record<string, unknown>)[key ?? ""] as unknown[]);
  return Array.isArray(list) ? list.length : 0;
}

/**
 * Does the configured store actually work?
 *
 * It is asked to hold a case and give it back, then to forget it. A store that
 * is reported as live because its constructor did not throw is a store that will
 * fail on the first write, which on this product is the moment a customer has
 * just told it what a contractor offered.
 */
async function checkStore(): Promise<Line[]> {
  const asked = (process.env["CIRCA_STORE"] ?? "file").toLowerCase();
  const lines: Line[] = [line("store requested", asked)];
  try {
    const repository = await configureRepository();
    lines.push(line("store", repository.describe()));
    const service = new CaseService(repository);
    const opened = await service.startCase({ userId: "doctor", issueSummary: "doctor round trip", trade: "general" });
    const read = await service.snapshot(opened.id);
    await service.deleteCase(opened.id);
    lines.push(
      read
        ? line("store round trip", "wrote a case, read it back, deleted it")
        : line("store round trip", "wrote a case and could not read it back", "warn"),
    );
  } catch (error) {
    lines.push(line("store", error instanceof Error ? error.message : String(error), "warn"));
  }
  return lines;
}

/**
 * AWS, asked the only question worth asking: do credentials resolve here?
 *
 * Not "is AWS_ACCESS_KEY_ID set". The provider chain is what an SDK client will
 * use at the moment it matters, so it is what is run, with a deadline on it.
 */
async function checkAws(): Promise<Line[]> {
  const lines: Line[] = [];
  try {
    const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
    const client = new DynamoDBClient({});
    const region = await within(3000, client.config.region());
    lines.push(region ? line("aws region", region) : line("aws region", "not resolved", "warn"));
    const credentials = await within(
      5000,
      client.config.credentials().then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, message: error instanceof Error ? error.message : String(error) }),
      ),
    );
    if (!credentials) {
      lines.push(line("aws credentials", "did not resolve within 5 s", "warn"));
    } else if (credentials.ok) {
      const id = credentials.value.accessKeyId;
      lines.push(line("aws credentials", `resolved (${id.slice(0, 4)}…${id.slice(-4)})`));
      lines.push(
        line(
          "aws credentials note",
          "resolving is not the same as being accepted; run `aws sts get-caller-identity`",
          "warn",
        ),
      );
    } else {
      lines.push(line("aws credentials", "none in this environment", "off", credentials.message));
    }
  } catch (error) {
    lines.push(line("aws sdk", error instanceof Error ? error.message : String(error), "warn"));
  }
  return lines;
}

/** Boot the real server, connect the real client, and read `/health` back. */
async function checkServer(): Promise<Line[]> {
  const lines: Line[] = [];
  const context = await createContext(process.env, { providers: new DemoProviderRepository() });
  const server = await startHttpServer(context, { port: 0 });
  const client = new Client({ name: "circa-doctor", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`));
  try {
    await client.connect(transport);
    lines.push(line("protocol negotiated", transport.protocolVersion ?? "unknown",
      transport.protocolVersion === REQUIRED_PROTOCOL_VERSION ? "ok" : "warn"));
    const { tools } = await client.listTools();
    const { resources } = await client.listResources();
    lines.push(line("tools", `${tools.length} registered, ${TOOL_NAMES.length} declared`,
      tools.length === TOOL_NAMES.length ? "ok" : "warn"));
    lines.push(line("mcp apps views", `${resources.length} of ${VIEWS.length}`,
      resources.length === VIEWS.length ? "ok" : "warn"));
    const health = (await (await fetch(`${server.url}/health`)).json()) as Record<string, unknown>;
    lines.push(line("health endpoint", health["protocolOk"] === true ? "protocolOk" : "protocol mismatch",
      health["protocolOk"] === true ? "ok" : "warn"));
  } catch (error) {
    lines.push(line("mcp server", error instanceof Error ? error.message : String(error), "warn"));
  } finally {
    await client.close().catch(() => undefined);
    await server.close();
  }
  return lines;
}

async function main(): Promise<void> {
  const groups: { title: string; lines: Line[] }[] = [];

  groups.push({
    title: "runtime",
    lines: [
      line("node", process.version, Number(process.versions.node.split(".")[0]) >= 22 ? "ok" : "warn"),
      line("platform", `${process.platform} ${process.arch}`),
      line("working directory", process.cwd()),
    ],
  });

  groups.push({
    title: "the add-on",
    lines: [
      line("protocol built against", SDK_PROTOCOL_VERSION,
        SDK_PROTOCOL_VERSION >= REQUIRED_PROTOCOL_VERSION ? "ok" : "warn"),
      line("required by Alexa+", REQUIRED_PROTOCOL_VERSION),
      ...(await checkServer()),
    ],
  });

  groups.push({ title: "storage", lines: await checkStore() });

  const optional: Line[] = [
    process.env["CIRCA_AUTH"] === "1"
      ? line("oauth", "on — bearer token required on /mcp")
      : line("oauth", "off — set CIRCA_AUTH=1 to require a token", "off"),
    process.env["CIRCA_BEDROCK"] === "1"
      ? line("bedrock", `on — ${process.env["CIRCA_MODEL_ID"] ?? "default model"}`)
      : line("bedrock", "off — the deterministic planner and phrasing are in use", "off"),
    process.env["CIRCA_TEXTRACT"] === "1"
      ? line("textract", "on — documents are read by DetectDocumentText")
      : line("textract", "off — documents are read as plain text", "off"),
  ];
  groups.push({ title: "optional paths", lines: optional });

  groups.push({ title: "aws", lines: await checkAws() });

  try {
    groups.push({
      title: "corpora",
      lines: [
        line("quote pairs", String(await corpusSize("fixtures/quotes/pairs.json", "pairs"))),
        line("injection documents", String(await corpusSize("fixtures/injection/documents.json", "documents"))),
        line("providers", String(await corpusSize("fixtures/providers/providers.json", "providers"))),
      ],
    });
  } catch (error) {
    groups.push({
      title: "corpora",
      lines: [line("fixtures", error instanceof Error ? error.message : String(error), "warn")],
    });
  }

  const out: string[] = ["", `${c(BOLD, "CIRCA")} — what is actually live here`];
  let warnings = 0;
  for (const group of groups) {
    out.push("", `  ${c(DIM, group.title)}`);
    for (const item of group.lines) {
      if (item.verdict === "warn") warnings += 1;
      const mark = item.verdict === "warn" ? c(YELLOW, MARK.warn) : c(DIM, MARK[item.verdict]);
      out.push(`  ${mark} ${item.label.padEnd(28)}${item.verdict === "off" ? c(DIM, item.value) : item.value}`);
      if (item.note) out.push(`    ${c(DIM, item.note.slice(0, 96))}`);
    }
  }
  out.push(
    "",
    c(DIM, "  Nothing above is required for the demo. `pnpm demo` and `pnpm eval` run"),
    c(DIM, "  complete with every optional path off and no AWS account."),
    "",
  );
  process.stdout.write(`${out.join("\n")}\n`);
  if (warnings > 0) process.stdout.write(`${c(YELLOW, `  ${warnings} line${warnings === 1 ? "" : "s"} marked !`)}\n\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
