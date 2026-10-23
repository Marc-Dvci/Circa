/**
 * The official MCP conformance suite, against the same in-process server.
 *
 * The suite is `@modelcontextprotocol/conformance`, pinned, and it is run once
 * against a server built from this repository with `--requirements 2025-11-25`,
 * which selects the scenarios that revision requires. The server is not changed
 * to make anything pass. Many scenarios call fixtures that the suite expects a
 * reference server to have (`test_image_content` and the like), and CIRCA has
 * none of them. Those failures are reported as they are.
 *
 * A scenario gets a `reason` only when its failure is traced to a fixture. The
 * trace has two parts: the fixture named in FIXTURES below, which was read from
 * the suite's own source, and a check against the live server, run before it is
 * shut down, that the fixture is absent. A failure that happens before the
 * fixture is reached, such as "Method not found" for a feature the server does
 * not implement, is not a fixture failure and gets no reason.
 *
 * Run: node node_modules/tsx/dist/cli.mjs tools/external/src/conformance.ts
 *
 * Writes docs/conformance/suite.json (`--check` writes nothing). The suite's own
 * exit code is recorded in the file; this script's exit code is about the
 * scenarios in APPLICABLE, the ones a server with CIRCA's capabilities and no
 * test fixtures can be held to.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CaseService, MemoryCaseRepository } from "#store";
import { createContext } from "../../../apps/mcp-server/src/context.js";
import { startHttpServer } from "../../../apps/mcp-server/src/http.js";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const DOCS = path.join(REPO, "docs", "conformance");

const SUITE = "@modelcontextprotocol/conformance";
const SUITE_VERSION = "0.2.0-alpha.12";
const REQUIREMENTS = "2025-11-25";
const RUN_TIMEOUT_MS = 20 * 60_000;

const ANSI = /\x1b\[[0-9;]*m/g;

type Fixture = { kind: "tool"; name: string } | { kind: "resource"; uri: string };

/**
 * The fixture each scenario asks for, as the suite's source names it.
 *
 * `tools-call-simple-text` and `tools-call-error` are here because they report
 * SUCCESS on a result that is an isError "not found" for their fixture, so the
 * pass is noted rather than believed.
 *
 * `tools-call-with-logging` is not here. It fails on logging/setLevel, which
 * the server answers with "Method not found", before it calls its fixture
 * `test_tool_with_logging`. The failure is the missing feature.
 *
 * `elicitation-sep1034-defaults` and `elicitation-sep1330-enums` are here on the
 * strength of the source, because the suite's check reads only "the server did
 * not request elicitation", which a missing tool also produces.
 */
const FIXTURES: Record<string, Fixture> = {
  "tools-call-simple-text": { kind: "tool", name: "test_simple_text" },
  "tools-call-error": { kind: "tool", name: "test_error_handling" },
  "tools-call-image": { kind: "tool", name: "test_image_content" },
  "tools-call-audio": { kind: "tool", name: "test_audio_content" },
  "tools-call-embedded-resource": { kind: "tool", name: "test_embedded_resource" },
  "tools-call-mixed-content": { kind: "tool", name: "test_multiple_content_types" },
  "tools-call-with-progress": { kind: "tool", name: "test_tool_with_progress" },
  "tools-call-sampling": { kind: "tool", name: "test_sampling" },
  "tools-call-elicitation": { kind: "tool", name: "test_elicitation" },
  "elicitation-sep1034-defaults": { kind: "tool", name: "test_elicitation_sep1034_defaults" },
  "elicitation-sep1330-enums": { kind: "tool", name: "test_elicitation_sep1330_enums" },
  "resources-read-text": { kind: "resource", uri: "test://static-text" },
  "resources-read-binary": { kind: "resource", uri: "test://static-binary" },
  "resources-templates-read": { kind: "resource", uri: "test://template/123/data" },
  "json-schema-2020-12": { kind: "tool", name: "json_schema_2020_12_tool" },
  "server-sse-polling": { kind: "tool", name: "test_reconnection" },
};

interface RawCheck {
  id?: string;
  name?: string;
  description?: string;
  status?: string;
  errorMessage?: string;
  message?: string;
}

interface Finding {
  check: string;
  message: string;
}

interface ScenarioResult {
  id: string;
  scored: boolean;
  status: "pass" | "fail" | "no-result";
  failures?: Finding[];
  warnings?: Finding[];
  reason?: string;
}

function npxEntry(): string {
  const candidates = [
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npx-cli.js"),
    path.join(path.dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npx-cli.js"),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error(`npx-cli.js not found; looked in ${candidates.join(" and ")}`);
  return found;
}

interface Ran {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function suiteCli(args: string[], timeoutMs: number, echo: boolean): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [npxEntry(), "-y", `${SUITE}@${SUITE_VERSION}`, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (echo) process.stdout.write(chunk.replace(ANSI, ""));
    });
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? -1, stdout: stdout.replace(ANSI, ""), stderr: stderr.replace(ANSI, ""), timedOut });
    });
  });
}

/**
 * Scenario ids from `list --server --requirements <rev>`: the scored server
 * section, and the server scenarios it runs but never scores.
 */
function listedScenarios(listing: string): { scored: string[]; unscored: string[] } {
  const lines = listing.split(/\r?\n/);
  const scored: string[] = [];
  const header = lines.findIndex((line) => line.startsWith("Server scenarios"));
  if (header < 0) throw new Error("the suite's list output has no Server scenarios section");
  for (const line of lines.slice(header + 1)) {
    const match = /^\s+-\s+(\S+)\s*$/.exec(line);
    if (match?.[1]) {
      scored.push(match[1]);
      continue;
    }
    if (scored.length > 0) break;
  }

  const unscored: string[] = [];
  const neverScored = lines.findIndex((line) => line.startsWith("Run and reported, but never scored"));
  if (neverScored >= 0) {
    for (const line of lines.slice(neverScored + 1)) {
      const match = /^\s+-\s+(\S+)\s+\[server\]\s*$/.exec(line);
      if (match?.[1]) unscored.push(match[1]);
    }
  }
  return { scored, unscored };
}

/** Directories are `server-<scenario>-<timestamp>`. The scenario id itself contains hyphens. */
async function resultDirectories(outDir: string): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for (const entry of await readdir(outDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const match = /^server-(.+)-\d{4}-\d{2}-\d{2}T[\d-]+Z$/.exec(entry.name);
    if (match?.[1]) found.set(match[1], path.join(outDir, entry.name));
  }
  return found;
}

function messageOf(check: RawCheck): string {
  const text = check.errorMessage ?? check.message ?? check.description ?? "";
  return text.replace(/\s+/g, " ").trim();
}

function findingsWith(checks: RawCheck[], status: string): Finding[] {
  return checks
    .filter((check) => check.status === status)
    .map((check) => ({ check: check.id ?? check.name ?? "unnamed", message: messageOf(check) }));
}

function fixtureName(fixture: Fixture): string {
  return fixture.kind === "tool" ? fixture.name : fixture.uri;
}

async function resourceIsAbsent(client: Client, uri: string): Promise<boolean> {
  try {
    await client.readResource({ uri });
    return false;
  } catch (error) {
    return /not found/i.test(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Asks the live server, over the wire, whether each fixture a scenario names is
 * present. Called before the server is closed.
 */
async function fixtureAbsence(url: string): Promise<Map<string, boolean>> {
  const client = new Client({ name: "circa-conformance-trace", version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  try {
    const { tools } = await client.listTools();
    const toolNames = new Set(tools.map((tool) => tool.name));
    const absence = new Map<string, boolean>();
    for (const [scenario, fixture] of Object.entries(FIXTURES)) {
      const absent = fixture.kind === "tool" ? !toolNames.has(fixture.name) : await resourceIsAbsent(client, fixture.uri);
      absence.set(scenario, absent);
    }
    return absence;
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function main(): Promise<number> {
  const ranAt = new Date().toISOString();
  console.log(`${SUITE} ${SUITE_VERSION}, requirements ${REQUIREMENTS}`);

  const listing = await suiteCli(["list", "--server", "--requirements", REQUIREMENTS], RUN_TIMEOUT_MS, false);
  if (listing.exitCode !== 0) throw new Error(`list failed with exit ${listing.exitCode}: ${listing.stderr.slice(0, 400)}`);
  const { scored, unscored } = listedScenarios(listing.stdout);
  if (scored.length === 0) throw new Error("no server scenarios were listed for the requirement set");
  console.log(`  ${scored.length} scored server scenarios, ${unscored.length} run but not scored, in the ${REQUIREMENTS} set`);

  const context = await createContext({} as NodeJS.ProcessEnv, { service: new CaseService(new MemoryCaseRepository()) });
  const running = await startHttpServer(context, { port: 0, host: "127.0.0.1" });
  const url = `http://127.0.0.1:${running.port}/mcp`;
  const outDir = await mkdtemp(path.join(os.tmpdir(), "circa-conformance-"));
  console.log(`  server ${url}`);
  console.log(`  raw results ${outDir}`);

  let outcome: { ran: Ran; absence: Map<string, boolean> } | undefined;
  try {
    const ran = await suiteCli(["server", "--url", url, "--requirements", REQUIREMENTS, "-o", outDir], RUN_TIMEOUT_MS, true);
    outcome = { ran, absence: await fixtureAbsence(url) };
  } finally {
    await running.close();
  }
  if (!outcome) throw new Error("the run produced no outcome");
  const { ran, absence } = outcome;
  if (ran.timedOut) throw new Error("the suite did not finish within the time limit");

  const directories = await resultDirectories(outDir);
  const totals = /Total: (\d+) passed, (\d+) failed/.exec(ran.stdout);
  const notes: string[] = [
    totals
      ? `The suite counts checks, not scenarios: its summary reads ${totals[1]} checks passed and ${totals[2]} failed. The counts in this file are per scenario.`
      : "The suite's summary line was not found, so the check totals are not recorded. The counts in this file are per scenario.",
  ];
  const scenarios: ScenarioResult[] = [
    ...scored.map((id) => ({ id, scored: true })),
    ...unscored.map((id) => ({ id, scored: false })),
  ].map(({ id, scored: isScored }): ScenarioResult => {
    const dir = directories.get(id);
    if (!dir) return { id, scored: isScored, status: "no-result" };
    return { id, scored: isScored, status: "pass" };
  });

  for (const result of scenarios) {
    const dir = directories.get(result.id);
    if (!dir) continue;
    const checks = JSON.parse(await readFile(path.join(dir, "checks.json"), "utf8")) as RawCheck[];
    const failures = findingsWith(checks, "FAILURE");
    const warnings = findingsWith(checks, "WARNING");
    if (failures.length > 0) {
      result.status = "fail";
      result.failures = failures;
    }
    if (warnings.length > 0) result.warnings = warnings;

    const fixture = FIXTURES[result.id];
    const missing = fixture !== undefined && absence.get(result.id) === true;
    if (fixture && missing && failures.length > 0) {
      result.reason = `missing fixture: "${fixtureName(fixture)}"`;
    }
    const recordedNotFound = fixture !== undefined && JSON.stringify(checks).includes(`${fixtureName(fixture)} not found`);
    if (fixture && missing && failures.length === 0 && recordedNotFound) {
      notes.push(
        `${result.id} passed, but its recorded result is an isError saying "${fixtureName(fixture)} not found". The pass does not show tool output.`,
      );
    }
  }

  for (const result of scenarios) {
    const label = result.status === "pass" ? "pass" : result.status === "fail" ? "FAIL" : "none";
    const first = result.failures?.[0]?.message ?? "";
    console.log(`  ${label.padEnd(5)} ${result.id}${result.scored ? "" : " (not scored)"}${first ? `  ${first.slice(0, 110)}` : ""}`);
  }

  const scoredResults = scenarios.filter((s) => s.scored);
  const scoredPass = scoredResults.filter((s) => s.status === "pass").length;
  const unscoredResults = scenarios.filter((s) => !s.scored);
  const unscoredPass = unscoredResults.filter((s) => s.status === "pass").length;
  console.log(
    `  scored: ${scoredPass} pass, ${scoredResults.length - scoredPass} not passing. Not scored: ${unscoredPass} pass, ${unscoredResults.length - unscoredPass} not passing. Suite exit code ${ran.exitCode}.`,
  );

  const suite = {
    suite: SUITE,
    version: SUITE_VERSION,
    requirements: REQUIREMENTS,
    ranAt,
    node: process.version,
    exitCode: ran.exitCode,
    summary: {
      scored: scoredResults.length,
      scoredPass,
      scoredNotPassing: scoredResults.length - scoredPass,
      notScored: unscoredResults.length,
      notScoredNotPassing: unscoredResults.length - unscoredPass,
    },
    notes,
    scenarios,
  };
  /**
   * The scenarios that apply to a server with CIRCA's declared capabilities and
   * no test fixtures. These must pass; CI fails if one stops. Two of them,
   * dns-rebinding-protection and server-session-lifecycle, failed on the first
   * run of this suite and were fixed in apps/mcp-server/src/http.ts.
   */
  const broken = APPLICABLE.filter((id) => scenarios.find((s) => s.id === id)?.status !== "pass");
  console.log(`  applicable: ${APPLICABLE.length - broken.length} of ${APPLICABLE.length} pass${broken.length ? `; not passing: ${broken.join(", ")}` : ""}`);
  const record = { ...suite, applicable: { scenarios: APPLICABLE, pass: APPLICABLE.length - broken.length } };

  if (!process.argv.includes("--check")) {
    await mkdir(DOCS, { recursive: true });
    await writeFile(path.join(DOCS, "suite.json"), `${JSON.stringify(record, null, 2)}\n`);
    console.log(`Wrote ${path.join(DOCS, "suite.json")}`);
  }
  return broken.length === 0 ? 0 : 1;
}

const APPLICABLE = [
  "server-initialize",
  "ping",
  "tools-list",
  "resources-list",
  "server-sse-multiple-streams",
  "dns-rebinding-protection",
  "server-session-lifecycle",
];

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
  },
);
