import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CaseService, MemoryCaseRepository } from "#store";
import { createContext } from "../../../apps/mcp-server/src/context.js";
import { startHttpServer } from "../../../apps/mcp-server/src/http.js";
import { SCRIPT, type Beat } from "./script.js";

/**
 * `pnpm demo`.
 *
 * The demo runs over the wire. It starts the real MCP server, connects the SDK's
 * own Streamable HTTP client to it, and calls the same fourteen tools Alexa+
 * would call — because a demo that reached into the service directly would be
 * proving that the service works, which was never in question, rather than that
 * the add-on does.
 *
 * `--tour` slows it down and prints the reasoning; `--json` emits every payload
 * for the simulator and the docs to consume.
 */

const BOLD = "[1m";
const DIM = "[2m";
const CYAN = "[36m";
const YELLOW = "[33m";
const RESET = "[0m";

const colour = process.stdout.isTTY && !process.env["NO_COLOR"];
const c = (code: string, text: string): string => (colour ? `${code}${text}${RESET}` : text);

interface Recorded {
  beat: Beat;
  speech: string;
  payload: Record<string, unknown>;
  ms: number;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function substitute(value: unknown, bindings: Record<string, string>): unknown {
  if (typeof value === "string" && value.startsWith("$")) {
    const bound = bindings[value.slice(1)];
    if (bound === undefined) throw new Error(`the script referred to ${value} before anything set it`);
    return bound;
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, bindings));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, bindings)]));
  }
  return value;
}

export async function runDemo(options: { tour?: boolean; onBeat?: (r: Recorded) => void } = {}): Promise<Recorded[]> {
  const context = await createContext({} as NodeJS.ProcessEnv, {
    service: new CaseService(new MemoryCaseRepository()),
  });
  const server = await startHttpServer(context, { port: 0 });
  const transport = new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`));
  const client = new Client({ name: "circa-demo", version: "0.1.0" });
  await client.connect(transport);

  const bindings: Record<string, string> = {};
  const recorded: Recorded[] = [];

  try {
    for (const beat of SCRIPT) {
      const args = substitute(beat.arguments, bindings) as Record<string, unknown>;
      const started = performance.now();
      const result = await client.callTool({ name: beat.tool, arguments: args });
      const ms = performance.now() - started;
      if (result.isError) {
        throw new Error(`${beat.tool}: ${(result.content as { text: string }[])[0]?.text ?? "failed"}`);
      }
      const payload = (result.structuredContent ?? {}) as Record<string, unknown>;

      if (typeof payload["caseId"] === "string" && !bindings["caseId"]) bindings["caseId"] = payload["caseId"];
      if (beat.tool === "find_independent_professionals") {
        const matches = payload["matches"] as { id: string }[] | undefined;
        if (matches?.[0]) bindings["providerId"] = matches[0].id;
      }
      if (beat.tool === "add_quote" && typeof payload["quoteId"] === "string") {
        const key = (args["source"] as string) === "CONTRACTOR" ? "quoteApex" : "quoteB";
        bindings[key] = payload["quoteId"];
      }
      if (beat.tool === "record_scope_change" && typeof payload["changeId"] === "string") {
        bindings["changeId"] = payload["changeId"];
      }

      const speech = (result.content as { type: string; text: string }[])
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join(" ");
      const entry: Recorded = { beat, speech, payload, ms };
      recorded.push(entry);
      options.onBeat?.(entry);
      if (options.tour) await sleep(1400);
    }
  } finally {
    await client.close().catch(() => undefined);
    await server.close();
  }
  return recorded;
}

function printBeat(entry: Recorded, tour: boolean): void {
  const { beat, speech, payload, ms } = entry;
  const out: string[] = [""];
  if (beat.caption) out.push(c(DIM, `  — ${beat.caption} —`));
  if (beat.said) out.push(`  ${c(BOLD, "You")}    ${beat.said}`);
  out.push(`  ${c(CYAN, "CIRCA")}  ${speech}`);
  const rows = (payload["rows"] as { label: string; value: string; attention?: boolean }[] | undefined) ?? [];
  for (const row of rows.slice(0, 6)) {
    out.push(`         ${c(DIM, row.label.padEnd(30))}${row.attention ? c(YELLOW, row.value) : row.value}`);
  }
  const refusal = payload["refusal"] as string | undefined;
  if (refusal) out.push(`         ${c(YELLOW, refusal)}`);
  if (tour && beat.note) out.push(`  ${c(DIM, `         ${beat.note}`)}`);
  out.push(c(DIM, `         ${beat.tool} · ${ms.toFixed(0)} ms`));
  process.stdout.write(`${out.join("\n")}\n`);
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const tour = args.has("--tour");
  const json = args.has("--json");

  if (!json) {
    process.stdout.write(
      `\n${c(BOLD, "CIRCA")} — a second opinion before you say yes\n${c(DIM, "  Every line below is a real MCP tool call over Streamable HTTP.")}\n`,
    );
  }

  const recorded = await runDemo({ tour, onBeat: json ? undefined : (entry) => printBeat(entry, tour) });

  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        recorded.map((r) => ({ tool: r.beat.tool, said: r.beat.said ?? null, caption: r.beat.caption ?? null, note: r.beat.note ?? null, speech: r.speech, ms: Math.round(r.ms), payload: r.payload })),
        null,
        2,
      )}\n`,
    );
    return;
  }

  const total = recorded.reduce((sum, r) => sum + r.ms, 0);
  const slowest = [...recorded].sort((a, b) => b.ms - a.ms)[0]!;
  process.stdout.write(
    `\n${c(DIM, `  ${recorded.length} tool calls, ${total.toFixed(0)} ms in total, slowest ${slowest.beat.tool} at ${slowest.ms.toFixed(0)} ms.`)}\n\n`,
  );
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop()!)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
}
