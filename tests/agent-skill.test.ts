import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { INDEPENDENT_QUOTE, ITEMISED_REQUOTE } from "../tools/demo/src/script.js";
import { TOOL_NAMES } from "../apps/mcp-server/src/tools.js";

/**
 * The Agent Skill in `skills/circa-quote-check/`, checked the way an agent
 * would use it.
 *
 * The frontmatter is held to the Agent Skills specification (agentskills.io):
 * a lowercase hyphenated name that matches its folder, a description under
 * 1024 characters. CI also runs the specification's reference validator,
 * `skills-ref validate`. Then the shell lines in the skill's worked example are
 * read out of SKILL.md and executed in order, each as its own process, with the
 * placeholders filled from the JSON the previous lines printed. If the skill
 * tells an agent to run something that does not work, this fails.
 */

const run = promisify(execFile);
const SKILL_DIR = path.resolve("skills/circa-quote-check");
const TSX = path.resolve("node_modules/tsx/dist/cli.mjs");

let skill: string;
let stateDir: string;

beforeAll(async () => {
  skill = await readFile(path.join(SKILL_DIR, "SKILL.md"), "utf8");
  stateDir = await mkdtemp(path.join(tmpdir(), "circa-skill-"));
});

afterAll(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

function frontmatter(text: string): Record<string, string> {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text.replace(/\r\n/g, "\n"));
  if (!match) throw new Error("SKILL.md has no frontmatter");
  const fields: Record<string, string> = {};
  for (const line of match[1]!.split("\n")) {
    const field = /^([a-z-]+):\s?(.*)$/.exec(line);
    if (field) fields[field[1]!] = field[2]!;
  }
  return fields;
}

/** Split `pnpm --silent tool <name> '<json>' [--text-file <path>]` into what execFile needs. */
function parseLine(line: string): { name: string; json: string; textFile?: string } {
  const match = /^pnpm --silent tool (\w+) '([^']*)'(?: --text-file (\S+))?$/.exec(line.trim());
  if (!match) throw new Error(`not a tool line: ${line}`);
  return { name: match[1]!, json: match[2]!, ...(match[3] ? { textFile: match[3] } : {}) };
}

describe("the Agent Skill", () => {
  it("meets the Agent Skills specification's frontmatter rules", () => {
    const fields = frontmatter(skill);
    expect(fields["name"]).toBe(path.basename(SKILL_DIR));
    expect(fields["name"]).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    expect(fields["name"]!.length).toBeLessThanOrEqual(64);
    expect(fields["description"]!.length).toBeGreaterThan(0);
    expect(fields["description"]!.length).toBeLessThanOrEqual(1024);
    expect(fields["compatibility"]!.length).toBeLessThanOrEqual(500);
    expect(skill.split("\n").length).toBeLessThan(500);
  });

  it("names every MCP tool, so an agent reading it knows the whole surface", () => {
    for (const tool of TOOL_NAMES) expect(skill, tool).toContain(`\`${tool}\``);
  });

  it("ships the example documents the demo sends, byte for byte", async () => {
    expect((await readFile(path.join(SKILL_DIR, "references/example-assessment.txt"), "utf8")).trimEnd()).toBe(INDEPENDENT_QUOTE);
    expect((await readFile(path.join(SKILL_DIR, "references/example-itemised-requote.txt"), "utf8")).trimEnd()).toBe(ITEMISED_REQUOTE);
  });

  it("runs its worked example, line by line, as an agent with a shell would", async () => {
    const block = /## Worked example[\s\S]*?```bash\n([\s\S]*?)```/.exec(skill.replace(/\r\n/g, "\n"));
    const lines = block![1]!.split("\n").filter((l) => l.startsWith("pnpm --silent tool"));
    expect(lines.length).toBe(14);

    const bound: Record<string, string> = {};
    const outputs: { tool: string; speech: string; structuredContent: Record<string, unknown> | null }[] = [];
    for (const line of lines) {
      const { name, json, textFile } = parseLine(line);
      const filled = json.replace(/<(\w+)>/g, (_m, key: string) => {
        if (!bound[key]) throw new Error(`${name} needs <${key}> before anything set it`);
        return bound[key]!;
      });
      const { stdout } = await run(
        process.execPath,
        [TSX, "tools/cli/src/tool.ts", name, filled, ...(textFile ? ["--text-file", textFile] : [])],
        { env: { ...process.env, CIRCA_STATE_DIR: stateDir, CIRCA_STORE: "file" } },
      );
      const out = JSON.parse(stdout) as { tool: string; isError: boolean; speech: string; structuredContent: Record<string, unknown> | null };
      expect(out.isError, `${name}: ${out.speech}`).toBe(false);
      outputs.push(out);

      const sc = out.structuredContent ?? {};
      if (name === "start_repair_case") bound["caseId"] = sc["caseId"] as string;
      if (name === "find_independent_professionals") bound["providerId"] = (sc["matches"] as { id: string }[])[0]!.id;
      if (name === "add_quote") bound[json.includes("SECOND_OPINION") ? "assessmentId" : "requoteId"] = sc["quoteId"] as string;
      if (name === "record_scope_change") bound["changeId"] = sc["changeId"] as string;
    }

    const compares = outputs.filter((o) => o.tool === "compare_quotes");
    expect(compares[0]!.structuredContent?.["refusal"]).toBeTruthy();
    expect(compares[0]!.speech).toContain("I cannot set these side by side");
    for (const fragment of ["$4,030", "$420", "$200", "Seal penetrations"]) expect(compares[1]!.speech).toContain(fragment);
  }, 180_000);
});
