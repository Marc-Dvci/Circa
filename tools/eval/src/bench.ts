import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createContext } from "../../../apps/mcp-server/src/context.js";
import { startHttpServer } from "../../../apps/mcp-server/src/http.js";
import { TOOL_NAMES, type ToolName } from "../../../apps/mcp-server/src/tools.js";
import { SCRIPT } from "../../demo/src/script.js";

/**
 * `pnpm bench`.
 *
 * Alexa+ publishes a latency budget for an add-on — **under 500 ms round trip**
 * — and a published number the project never measures is a wish. So this drives
 * every one of the sixteen tools through the SDK's own client over Streamable
 * HTTP, N complete repairs deep, and reports what the client actually waited.
 *
 * Three decisions worth knowing about before reading a number off it:
 *
 * **It is the client's wait, not the handler's.** The timer starts before
 * `client.callTool` and stops when the result is in hand, so JSON-RPC framing,
 * the HTTP round trip, zod validation of the arguments and the structured
 * output all sit inside it. The server's own per-handler timings are in
 * `/metrics` and are always the smaller number; the one a customer feels is
 * this one.
 *
 * **The hop is loopback.** This measures the add-on, not the internet between
 * an Echo and wherever it is deployed. What it can honestly answer is whether
 * CIRCA's own work is a meaningful fraction of the budget, and the answer is
 * that it is not — which is the useful claim, because it means the deployment
 * decides the latency and the product does not.
 *
 * **The first call of the process is reported separately.** Node's first trip
 * through a code path pays for compilation, and folding that into a p50 across
 * twenty iterations quietly flatters every later one. It is printed on its own
 * line instead.
 */

interface Sample {
  tool: ToolName;
  ms: number;
}

const BOLD = "[1m";
const DIM = "[2m";
const YELLOW = "[33m";
const RESET = "[0m";

const colour = process.stdout.isTTY && !process.env["NO_COLOR"];
const c = (code: string, text: string): string => (colour ? `${code}${text}${RESET}` : text);

/** Nearest-rank, the same as `Metrics`. With twenty samples an interpolated p95 is a number nobody measured. */
function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1);
  return sorted[Math.max(0, rank)] ?? 0;
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

/**
 * One complete repair, plus the four tools the demo arc does not reach.
 *
 * The demo script covers twelve of the sixteen. Benchmarking only those would
 * report a latency profile for the tools that were easy to reach, so the
 * remaining four — the status read, the change review, the case list and the
 * delete — are appended here. `delete_repair_case` goes last for the obvious
 * reason, and it is genuinely called: a delete that is measured on a case that
 * does not exist is measuring the error path.
 */
async function oneRepair(client: Client, record: (sample: Sample) => void): Promise<void> {
  const bindings: Record<string, string> = {};

  const call = async (tool: ToolName, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const started = performance.now();
    const result = await client.callTool({ name: tool, arguments: args });
    record({ tool, ms: performance.now() - started });
    if (result.isError) {
      throw new Error(`${tool}: ${(result.content as { text: string }[])[0]?.text ?? "failed"}`);
    }
    return (result.structuredContent ?? {}) as Record<string, unknown>;
  };

  for (const beat of SCRIPT) {
    const args = substitute(beat.arguments, bindings) as Record<string, unknown>;
    const payload = await call(beat.tool, args);
    if (typeof payload["caseId"] === "string" && !bindings["caseId"]) bindings["caseId"] = payload["caseId"];
    if (beat.tool === "find_independent_professionals") {
      const matches = payload["matches"] as { id: string }[] | undefined;
      if (matches?.[0]) bindings["providerId"] = matches[0].id;
    }
    if (beat.tool === "add_quote" && typeof payload["quoteId"] === "string") {
      bindings[(args["source"] as string) === "CONTRACTOR" ? "quoteApex" : "quoteB"] = payload["quoteId"];
    }
    if (beat.tool === "record_scope_change" && typeof payload["changeId"] === "string") {
      bindings["changeId"] = payload["changeId"];
    }
  }

  const caseId = bindings["caseId"]!;
  await call("get_verification_status", { caseId });
  await call("review_scope_change", { caseId, changeId: bindings["changeId"]! });
  await call("list_repair_cases", {});
  await call("delete_repair_case", { caseId });
}

export interface BenchResult {
  tool: string;
  calls: number;
  p50: number;
  p95: number;
  max: number;
}

export async function bench(iterations: number): Promise<{ rows: BenchResult[]; firstCallMs: number; totalMs: number }> {
  const context = await createContext();
  const server = await startHttpServer(context, { port: 0 });
  const transport = new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`));
  const client = new Client({ name: "circa-bench", version: "0.1.0" });
  await client.connect(transport);

  const samples: Sample[] = [];
  let firstCallMs = 0;
  const started = performance.now();
  try {
    for (let i = 0; i < iterations; i += 1) {
      await oneRepair(client, (sample) => {
        if (samples.length === 0) firstCallMs = sample.ms;
        samples.push(sample);
      });
    }
  } finally {
    await client.close().catch(() => undefined);
    await server.close();
  }
  const totalMs = performance.now() - started;

  const rows: BenchResult[] = TOOL_NAMES.map((tool) => {
    // The first call of the process is excluded from the quantiles and printed
    // on its own line. Excluding it from `calls` too would make the table lie
    // about how much work it is describing, so it stays counted.
    const timings = samples.filter((s) => s.tool === tool);
    const measured = samples[0]?.tool === tool && timings.length > 1 ? timings.slice(1) : timings;
    const sorted = measured.map((s) => s.ms).sort((a, b) => a - b);
    return {
      tool,
      calls: timings.length,
      p50: quantile(sorted, 0.5),
      p95: quantile(sorted, 0.95),
      max: sorted.at(-1) ?? 0,
    };
  }).sort((a, b) => b.p95 - a.p95);

  return { rows, firstCallMs, totalMs };
}

const BUDGET_MS = 500;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const nArg = args.find((a) => /^--(?:n|iterations)=/.test(a));
  const iterations = Math.max(1, Number(nArg?.split("=")[1] ?? 20));
  const json = args.includes("--json");

  const { rows, firstCallMs, totalMs } = await bench(iterations);
  const calls = rows.reduce((sum, r) => sum + r.calls, 0);

  if (json) {
    process.stdout.write(`${JSON.stringify({ iterations, calls, firstCallMs, totalMs, budgetMs: BUDGET_MS, rows }, null, 2)}\n`);
    return;
  }

  const worst = rows[0]!;
  const lines: string[] = [
    "",
    `${c(BOLD, "LATENCY")}  ${calls} tool calls over Streamable HTTP, ${iterations} complete repairs, client-side round trip`,
    "",
    `  ${"tool".padEnd(32)}${"calls".padStart(6)}${"p50".padStart(9)}${"p95".padStart(9)}${"max".padStart(9)}`,
  ];
  for (const row of rows) {
    const over = row.p95 >= BUDGET_MS;
    lines.push(
      `  ${row.tool.padEnd(32)}${String(row.calls).padStart(6)}${`${row.p50.toFixed(1)}`.padStart(9)}${c(
        over ? YELLOW : "",
        `${row.p95.toFixed(1)}`.padStart(9),
      )}${`${row.max.toFixed(1)}`.padStart(9)}`,
    );
  }
  lines.push(
    "",
    `  slowest tool at p95              ${worst.tool} at ${worst.p95.toFixed(1)} ms`,
    `  Alexa+ round-trip budget         ${BUDGET_MS} ms`,
    `  headroom at the slowest tool     ${(BUDGET_MS - worst.p95).toFixed(1)} ms`,
    `  first call of the process        ${firstCallMs.toFixed(1)} ms  ${c(DIM, "(cold path, excluded from the quantiles above)")}`,
    `  wall clock                       ${(totalMs / 1000).toFixed(2)} s`,
    "",
    c(DIM, "  Loopback, so this measures the add-on and not the network to it. The"),
    c(DIM, "  server's own per-handler timings, which are smaller, are at /metrics."),
    "",
  );
  process.stdout.write(`${lines.join("\n")}\n`);

  if (worst.p95 >= BUDGET_MS) {
    process.stderr.write(`${worst.tool} is over the ${BUDGET_MS} ms budget at p95.\n`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop()!)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
}
