/**
 * The MCP Inspector, against CIRCA.
 *
 * The client here is not written by this repository. It is the MCP Inspector CLI,
 * pinned to 2.12.0 and run through npx, one process per call. Each process
 * connects over Streamable HTTP, makes its one call and exits, so what is recorded
 * is what a client the team did not write was told by the server, not what the
 * repository's own SDK client agrees with itself about.
 *
 * The beats come from `tools/demo/src/script.ts`, the file the demo replays, and
 * placeholders are bound from earlier results the same way `tools/demo/src/run.ts`
 * binds them. The in-process server uses the memory store, as the conformance
 * test does, so the case lives in the server process and persists across the
 * separate Inspector processes.
 *
 * Run:    node node_modules/tsx/dist/cli.mjs tools/external/src/inspector.ts
 * Check:  node node_modules/tsx/dist/cli.mjs tools/external/src/inspector.ts --check
 *
 * Without `--check` the script writes docs/conformance/inspector.json and
 * docs/conformance/INSPECTOR.md, but only after every assertion has passed.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CaseService, MemoryCaseRepository } from "#store";
import { createContext } from "../../../apps/mcp-server/src/context.js";
import { startHttpServer } from "../../../apps/mcp-server/src/http.js";
import { SCRIPT, type Beat } from "../../demo/src/script.js";

type Json = Record<string, unknown>;

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const DOCS = path.join(REPO, "docs", "conformance");

const CLIENT = "@modelcontextprotocol/inspector";
const CLIENT_VERSION = "2.12.0";
/** Written out here, not imported, so the check does not compare the server's constant with itself. */
const REQUIRED_PROTOCOL = "2025-11-25";
const TOOL_COUNT = 16;
const RESOURCE_COUNT = 6;
const VIEW_URI = "ui://circa/comparison";
const CALL_TIMEOUT_MS = 120_000;
const PREVIEW_CHARS = 140;

interface CallRecord {
  method: string;
  toolName?: string;
  arguments?: Json;
  uri?: string;
  exitCode: number;
  ms: number;
  output: unknown;
}

interface CallSpec {
  method: string;
  cli: string[];
  toolName?: string;
  arguments?: Json;
  uri?: string;
}

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

interface InspectorDoc {
  client: string;
  clientVersion: string;
  ranAt: string;
  node: string;
  protocolVersion: string;
  calls: CallRecord[];
}

/**
 * npx is a .cmd shim on Windows. Spawning it needs a shell, and a shell would
 * split the JSON passed to --tool-args-json. So this runs npm's own npx-cli.js
 * with the same Node binary, which takes arguments verbatim.
 */
function npxEntry(): string {
  const candidates = [
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npx-cli.js"),
    path.join(path.dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npx-cli.js"),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error(`npx-cli.js not found; looked in ${candidates.join(" and ")}`);
  return found;
}

interface Spawned {
  exitCode: number;
  ms: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function inspect(url: string, cli: string[]): Promise<Spawned> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(
      process.execPath,
      [npxEntry(), "-y", `${CLIENT}@${CLIENT_VERSION}`, "--cli", url, "--transport", "http", ...cli, "--format", "json"],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, CALL_TIMEOUT_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? -1, ms: Math.round(performance.now() - started), stdout, stderr, timedOut });
    });
  });
}

function parseOutput(label: string, stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`${label}: Inspector stdout was not one JSON object: ${stdout.trim().slice(0, 300)}`);
  }
}

const resultOf = (output: unknown): Json => ((output as { result?: Json }).result ?? {}) as Json;
const structuredOf = (output: unknown): Json => (resultOf(output)["structuredContent"] ?? {}) as Json;

/** The spoken text is content[0].text, as the brief asks. Empty when the result has no text block. */
function spokenOf(output: unknown): string {
  const first = (resultOf(output)["content"] as { type?: string; text?: unknown }[] | undefined)?.[0];
  return first?.type === "text" && typeof first.text === "string" ? first.text : "";
}

function label(spec: CallSpec): string {
  return spec.toolName ? `${spec.method} ${spec.toolName}` : spec.method;
}

async function runCall(url: string, spec: CallSpec, calls: CallRecord[]): Promise<CallRecord> {
  const spawned = await inspect(url, spec.cli);
  const name = label(spec);
  if (spawned.timedOut) throw new Error(`${name}: the Inspector did not finish within ${CALL_TIMEOUT_MS} ms`);
  const output = parseOutput(name, spawned.stdout);
  const record: CallRecord = {
    method: spec.method,
    ...(spec.toolName ? { toolName: spec.toolName } : {}),
    ...(spec.arguments ? { arguments: spec.arguments } : {}),
    ...(spec.uri ? { uri: spec.uri } : {}),
    exitCode: spawned.exitCode,
    ms: spawned.ms,
    output,
  };
  calls.push(record);
  console.log(`  ${String(calls.length).padStart(2)}. ${name.padEnd(42)} exit=${spawned.exitCode}  ${spawned.ms} ms`);
  if (spawned.exitCode !== 0) {
    const isError = spawned.exitCode === 5 ? " (exit 5: a tool returned isError)" : "";
    const detail = spawned.stderr.trim().slice(0, 400);
    throw new Error(`${name} exited ${spawned.exitCode}${isError}${detail ? `; stderr: ${detail}` : ""}`);
  }
  return record;
}

/** The same placeholder rule as tools/demo/src/run.ts: a string starting with $ is looked up. */
function substitute(value: unknown, bindings: Record<string, string>): unknown {
  if (typeof value === "string" && value.startsWith("$")) {
    const bound = bindings[value.slice(1)];
    if (bound === undefined) throw new Error(`the script referred to ${value} before an earlier call set it`);
    return bound;
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, bindings));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, bindings)]));
  }
  return value;
}

/** The same bindings as tools/demo/src/run.ts, read from structuredContent. */
function bindFrom(beat: Beat, args: Json, output: unknown, bindings: Record<string, string>): void {
  const data = structuredOf(output);
  if (typeof data["caseId"] === "string" && bindings["caseId"] === undefined) bindings["caseId"] = data["caseId"];
  if (beat.tool === "find_independent_professionals") {
    const matches = data["matches"] as { id?: unknown }[] | undefined;
    const first = matches?.[0]?.id;
    if (typeof first === "string") bindings["providerId"] = first;
  }
  if (beat.tool === "add_quote" && typeof data["quoteId"] === "string") {
    bindings[args["source"] === "CONTRACTOR" ? "quoteApex" : "quoteB"] = data["quoteId"];
  }
  if (beat.tool === "record_scope_change" && typeof data["changeId"] === "string") {
    bindings["changeId"] = data["changeId"];
  }
}

async function runSequence(url: string, calls: CallRecord[]): Promise<void> {
  await runCall(url, { method: "initialize", cli: ["--method", "initialize"] }, calls);
  await runCall(url, { method: "tools/list", cli: ["--method", "tools/list"] }, calls);
  await runCall(url, { method: "resources/list", cli: ["--method", "resources/list"] }, calls);
  await runCall(
    url,
    { method: "resources/read", uri: VIEW_URI, cli: ["--method", "resources/read", "--uri", VIEW_URI] },
    calls,
  );

  const bindings: Record<string, string> = {};
  for (const beat of SCRIPT) {
    const args = substitute(beat.arguments, bindings) as Json;
    const record = await runCall(
      url,
      {
        method: "tools/call",
        toolName: beat.tool,
        arguments: args,
        cli: ["--method", "tools/call", "--tool-name", beat.tool, "--tool-args-json", JSON.stringify(args)],
      },
      calls,
    );
    bindFrom(beat, args, record.output, bindings);
  }
}

function verify(calls: CallRecord[]): Check[] {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail });
  };

  const initialize = calls.find((c) => c.method === "initialize");
  const negotiated = initialize ? resultOf(initialize.output)["protocolVersion"] : undefined;
  add(
    "negotiated protocolVersion",
    negotiated === REQUIRED_PROTOCOL,
    `got ${JSON.stringify(negotiated)}, expected "${REQUIRED_PROTOCOL}"`,
  );

  const toolList = calls.find((c) => c.method === "tools/list");
  const tools = toolList ? resultOf(toolList.output)["tools"] : undefined;
  const toolCount = Array.isArray(tools) ? tools.length : -1;
  const cursor = toolList ? resultOf(toolList.output)["nextCursor"] : undefined;
  add(
    "tools/list has exactly 16 tools",
    toolCount === TOOL_COUNT && cursor === undefined,
    `${toolCount} tools${cursor === undefined ? "" : ", and a nextCursor was returned so the list is partial"}`,
  );

  const resourceList = calls.find((c) => c.method === "resources/list");
  const resources = resourceList ? resultOf(resourceList.output)["resources"] : undefined;
  const resourceCount = Array.isArray(resources) ? resources.length : -1;
  add("resources/list has 6 resources", resourceCount === RESOURCE_COUNT, `${resourceCount} resources`);

  const comparisons = calls.filter((c) => c.toolName === "compare_quotes");
  const first = comparisons[0];
  const second = comparisons[1];
  const refusal = first ? structuredOf(first.output)["refusal"] : undefined;
  const firstSpeech = first ? spokenOf(first.output) : "";
  const refused =
    (typeof refusal === "string" && refusal.length > 0) ||
    (/side by side/i.test(firstSpeech) && /cannot|can't/i.test(firstSpeech));
  add(
    "first compare_quotes refuses (structuredContent.refusal, or speech says it cannot set them side by side)",
    comparisons.length === 2 && refused,
    comparisons.length !== 2
      ? `expected two compare_quotes calls, found ${comparisons.length}`
      : typeof refusal === "string" && refusal.length > 0
        ? `refusal present: ${refusal.slice(0, 120)}`
        : "no refusal field; checked speech instead",
  );

  const payoffSpeech = second ? spokenOf(second.output) : "";
  const needles = ["$4,030", "$420", "$200", "Seal penetrations"];
  const missing = needles.filter((needle) => !payoffSpeech.includes(needle));
  add(
    "second compare_quotes speech names $4,030, $420, $200 and Seal penetrations",
    second !== undefined && missing.length === 0,
    missing.length === 0 ? "all four present" : `missing: ${missing.join(", ")}`,
  );

  const errored = calls.filter((c) => c.exitCode !== 0 || resultOf(c.output)["isError"] === true);
  add(
    "every Inspector call exited 0, and no result carried isError",
    errored.length === 0,
    errored.length === 0 ? `${calls.length} calls, all exit 0` : `${errored.length} call(s) errored`,
  );

  return checks;
}

const cell = (text: string): string => text.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();

function preview(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS)}...` : flat;
}

function quoted(text: string): string {
  return text
    .split("\n")
    .map((line) => (line.length > 0 ? `> ${line}` : ">"))
    .join("\n");
}

function renderMarkdown(doc: InspectorDoc): string {
  const rows = doc.calls.map((call, index) => {
    const tool = call.toolName ?? "-";
    const text = spokenOf(call.output);
    const spoken = text.length > 0 ? cell(preview(text)) : "-";
    return `| ${index + 1} | ${call.method} | ${tool} | ${call.ms} | ${spoken} |`;
  });

  const comparisons = doc.calls
    .map((call, index) => ({ call, number: index + 1 }))
    .filter(({ call }) => call.toolName === "compare_quotes");
  const [before, after] = comparisons;

  const lines = [
    "# MCP Inspector against CIRCA",
    "",
    `This page was generated by \`tools/external/src/inspector.ts\`. The client was the MCP Inspector CLI, \`${doc.client}\` version ${doc.clientVersion}, run through npx against the CIRCA server at ${doc.ranAt} on Node ${doc.node}. The Inspector negotiated protocol version ${doc.protocolVersion}. Each call was a separate Inspector process, so \`process ms\` is the wall time of one npx start-up, connection and call, not the tool's latency (\`pnpm bench\` measures that). Later calls used identifiers taken from earlier results, and the server accepted them.`,
    "",
    "| # | method | tool | process ms | spoken text (first 140 characters) |",
    "|---|---|---|---|---|",
    ...rows,
    "",
    "## Quote comparisons",
    "",
  ];
  if (before) {
    lines.push(`### Before the itemised quote (call ${before.number})`, "", quoted(spokenOf(before.call.output)), "");
  }
  if (after) {
    lines.push(`### After the itemised quote (call ${after.number})`, "", quoted(spokenOf(after.call.output)), "");
  }
  lines.push(
    "Regenerate with `node node_modules/tsx/dist/cli.mjs tools/external/src/inspector.ts`. The JSON next to this page holds every Inspector result verbatim.",
    "",
  );
  return lines.join("\n");
}

async function main(): Promise<number> {
  const checkOnly = process.argv.slice(2).includes("--check");
  const ranAt = new Date().toISOString();
  console.log(`MCP Inspector ${CLIENT_VERSION} against CIRCA (${checkOnly ? "check only" : "will write docs/conformance"})`);

  const context = await createContext({} as NodeJS.ProcessEnv, { service: new CaseService(new MemoryCaseRepository()) });
  const running = await startHttpServer(context, { port: 0, host: "127.0.0.1" });
  // The brief's URL is ${running.url}/mcp. running.url says localhost, and the
  // server binds 127.0.0.1, so the address is built from the bound port here.
  const url = `http://127.0.0.1:${running.port}/mcp`;
  console.log(`  server ${url}`);

  const calls: CallRecord[] = [];
  const failures: string[] = [];
  try {
    await runSequence(url, calls);
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  } finally {
    await running.close();
  }

  const checks = failures.length === 0 ? verify(calls) : [];
  for (const check of checks) {
    console.log(`  ${check.ok ? "PASS" : "FAIL"}  ${check.name}: ${check.detail}`);
    if (!check.ok) failures.push(`${check.name}: ${check.detail}`);
  }

  if (failures.length > 0) {
    for (const failure of failures) console.error(`FAIL ${failure}`);
    console.error("Nothing was written.");
    return 1;
  }

  const protocolVersion = String(resultOf(calls[0]?.output)["protocolVersion"]);
  const doc: InspectorDoc = {
    client: CLIENT,
    clientVersion: CLIENT_VERSION,
    ranAt,
    node: process.version,
    protocolVersion,
    calls,
  };

  if (checkOnly) {
    console.log(`All ${checks.length} checks passed across ${calls.length} Inspector calls. Check mode: nothing written.`);
    return 0;
  }

  await mkdir(DOCS, { recursive: true });
  await writeFile(path.join(DOCS, "inspector.json"), `${JSON.stringify(doc, null, 2)}\n`);
  await writeFile(path.join(DOCS, "INSPECTOR.md"), renderMarkdown(doc));
  console.log(`All ${checks.length} checks passed across ${calls.length} Inspector calls.`);
  console.log(`Wrote ${path.join(DOCS, "inspector.json")}`);
  console.log(`Wrote ${path.join(DOCS, "INSPECTOR.md")}`);
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
  },
);
