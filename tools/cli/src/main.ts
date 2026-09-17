import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CaseService, configureRepository } from "#store";
import { DemoProviderRepository } from "#providers";
import { runVerification } from "#verification";
import type { OfferContext, Trade } from "#schema";
import {
  plan,
  presentChange,
  presentComparison,
  presentDossier,
  presentProviders,
  presentVerification,
  type PlannerState,
  type ViewPayload,
} from "#agent";
import { createContext } from "../../../apps/mcp-server/src/context.js";
import { startHttpServer } from "../../../apps/mcp-server/src/http.js";
import type { ToolName } from "../../../apps/mcp-server/src/tools.js";

/**
 * `pnpm circa` — the third door.
 *
 * The same case, the same rules and the same sentences, reached without MCP and
 * without a model. That is the point of the file rather than a convenience:
 * `apps/mcp-server/src/tools.ts` claims to hold no product logic, and the only
 * way to keep that claim true is to have a second caller that would notice if it
 * stopped being true. Every command here builds its output with the same
 * `present*` functions the MCP tools use, so what this prints is what Alexa
 * would say, word for word.
 *
 * One command is different. `circa say` boots the MCP server in-process, runs
 * the deterministic planner over an utterance, and executes whatever it planned
 * through the SDK's own client — the whole agent loop, on a machine with no
 * credentials, printing which pattern fired so a miss is traceable rather than
 * mysterious.
 */

const BOLD = "[1m";
const DIM = "[2m";
const CYAN = "[36m";
const YELLOW = "[33m";
const RESET = "[0m";

const colour = process.stdout.isTTY && !process.env["NO_COLOR"];
const c = (code: string, text: string): string => (colour ? `${code}${text}${RESET}` : text);

const CENTS = 100;
const dollars = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const parsed = Number(value.replace(/[$,]/g, ""));
  if (!Number.isFinite(parsed)) throw new Error(`${value} is not an amount`);
  return parsed;
};
const toCents = (value: number): number => Math.round(value * CENTS);

interface Args {
  positional: string[];
  flags: Record<string, string | true>;
}

/**
 * Flags that never take a value, so `--door-knock case_X` does not eat the case.
 *
 * Everything else accepts both `--file=path` and `--file path`. Only the first
 * form parsed for a while, and the help text printed the second, so every
 * documented invocation of `circa quote` answered "needs a case id and --file"
 * — including the one in the README.
 */
const BOOLEAN_FLAGS = new Set(["door-knock", "independent-only", "json", "tour"]);

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const [name, ...rest] = token.slice(2).split("=");
    if (rest.length > 0) {
      flags[name!] = rest.join("=");
      continue;
    }
    const next = argv[i + 1];
    if (!BOOLEAN_FLAGS.has(name!) && next !== undefined && !next.startsWith("--")) {
      flags[name!] = next;
      i += 1;
      continue;
    }
    flags[name!] = true;
  }
  return { positional, flags };
}

const str = (args: Args, name: string): string | undefined => {
  const value = args.flags[name];
  return typeof value === "string" ? value : undefined;
};

/** `--shown` is true, `--shown=false` is false, and an absent flag stays absent. */
const tri = (args: Args, name: string): boolean | undefined => {
  const value = args.flags[name];
  if (value === undefined) return undefined;
  if (value === true) return true;
  return !/^(?:false|no|0)$/i.test(value);
};

/**
 * Print a payload the way a screen would show it and a voice would say it.
 *
 * `speech` comes first and is the whole answer. The rows are underneath because
 * they are the same facts in a shape a person can scan, and the refusal is last
 * and unmissable, because on this product it is usually the finding.
 */
function printPayload(payload: ViewPayload): void {
  const out: string[] = ["", `  ${c(CYAN, payload.speech)}`];
  if (payload.rows.length > 0) out.push("");
  for (const row of payload.rows) {
    out.push(`  ${c(DIM, row.label.padEnd(30))}${row.attention ? c(YELLOW, row.value) : row.value}`);
  }
  if (payload.refusal) out.push("", `  ${c(YELLOW, payload.refusal)}`);
  if (payload.actions.length > 0) {
    out.push("", c(DIM, `  next: ${payload.actions.map((a) => a.label.toLowerCase()).join(" · ")}`));
  }
  out.push(c(DIM, `  ${payload.caseId} · ${payload.view}`), "");
  process.stdout.write(`${out.join("\n")}\n`);
}

async function service(): Promise<CaseService> {
  return new CaseService(await configureRepository());
}

const userId = (): string => process.env["CIRCA_USER"] ?? "user_demo";

// ── commands ────────────────────────────────────────────────────────────────

const COMMANDS: Record<string, { usage: string; blurb: string; run: (args: Args) => Promise<void> }> = {
  new: {
    usage: 'circa new "<what is wrong>" [--trade roofing] [--postcode 02139]',
    blurb: "Open a repair record.",
    run: async (args) => {
      const summary = args.positional[0];
      if (!summary) throw new Error("say what the repair is");
      const svc = await service();
      const opened = await svc.startCase({
        userId: userId(),
        issueSummary: summary,
        ...(str(args, "trade") ? { trade: str(args, "trade") as Trade } : {}),
        ...(str(args, "postcode") ? { postalCode: str(args, "postcode")! } : {}),
      });
      const snapshot = (await svc.snapshot(opened.id))!;
      printPayload(presentVerification(snapshot, runVerification(snapshot)));
    },
  },

  offer: {
    usage: 'circa offer <caseId> "<what they said>" [--price 6500] [--deposit 3000] [--company "Apex"] [--door-knock] [--urgency "..."]',
    blurb: "Record what a contractor offered. Prices in dollars.",
    run: async (args) => {
      const [caseId, description] = args.positional;
      if (!caseId || !description) throw new Error("needs a case id and what they said");
      const svc = await service();
      const context: Partial<OfferContext> = {};
      if (str(args, "urgency")) context.urgencyClaim = str(args, "urgency")!;
      if (args.flags["door-knock"]) {
        context.contractorFoundBy = "DOOR_KNOCK";
        context.solicited = false;
      }
      const price = dollars(str(args, "price"));
      const deposit = dollars(str(args, "deposit"));
      await svc.captureOffer({
        caseId,
        description,
        ...(str(args, "company") ? { companyName: str(args, "company")! } : {}),
        ...(price !== undefined ? { quotedPrice: toCents(price) } : {}),
        ...(deposit !== undefined ? { depositRequested: toCents(deposit) } : {}),
        context,
      });
      const snapshot = (await svc.snapshot(caseId))!;
      printPayload(presentVerification(snapshot, runVerification(snapshot)));
    },
  },

  answer: {
    usage: "circa answer <caseId> [--shown=false] [--written=false] [--licence] [--insurance] [--deadline TODAY]",
    blurb: "Answer the questions the checklist is waiting on. An unanswered question stays unanswered.",
    run: async (args) => {
      const caseId = args.positional[0];
      if (!caseId) throw new Error("needs a case id");
      const answers: Partial<OfferContext> = {};
      const shown = tri(args, "shown");
      const written = tri(args, "written");
      const licence = tri(args, "licence") ?? tri(args, "license");
      const insurance = tri(args, "insurance");
      if (shown !== undefined) answers.damageShownToCustomer = shown;
      if (written !== undefined) answers.writtenScopeProvided = written;
      if (licence !== undefined) answers.licenceNumberProvided = licence;
      if (insurance !== undefined) answers.insuranceEvidenceProvided = insurance;
      const deadline = str(args, "deadline");
      if (deadline) answers.decisionRequestedBy = deadline as OfferContext["decisionRequestedBy"];
      if (Object.keys(answers).length === 0) throw new Error("nothing to answer — pass at least one flag");
      const svc = await service();
      await svc.answerVerification({ caseId, answers });
      const snapshot = (await svc.snapshot(caseId))!;
      printPayload(presentVerification(snapshot, runVerification(snapshot)));
    },
  },

  status: {
    usage: "circa status <caseId>",
    blurb: "What has and has not been established.",
    run: async (args) => {
      const caseId = args.positional[0];
      if (!caseId) throw new Error("needs a case id");
      const svc = await service();
      const snapshot = await svc.snapshot(caseId);
      if (!snapshot) throw new Error(`no repair on record under ${caseId}`);
      printPayload(presentVerification(snapshot, runVerification(snapshot)));
    },
  },

  scope: {
    usage: "circa scope <caseId>",
    blurb: "The neutral assessment request, and what was deliberately left out of it.",
    run: async (args) => {
      const caseId = args.positional[0];
      if (!caseId) throw new Error("needs a case id");
      const svc = await service();
      const scope = await svc.structureScope(caseId);
      const out = ["", `  ${c(BOLD, "Assessment request")}`, "", ...scope.text.split("\n").map((l) => `  ${l}`), ""];
      out.push(`  ${c(DIM, "withheld on purpose")}`);
      for (const item of scope.withheld) out.push(`  ${c(YELLOW, "–")} ${item.what}  ${c(DIM, item.why)}`);
      out.push("");
      process.stdout.write(`${out.join("\n")}\n`);
    },
  },

  assessors: {
    usage: "circa assessors <caseId> [--limit 3] [--independent-only]",
    blurb: "Who could give a second opinion, ordered by how little they gain from the answer.",
    run: async (args) => {
      const caseId = args.positional[0];
      if (!caseId) throw new Error("needs a case id");
      const svc = await service();
      const snapshot = await svc.snapshot(caseId);
      if (!snapshot) throw new Error(`no repair on record under ${caseId}`);
      const providers = new DemoProviderRepository();
      const matches = await providers.find({
        trade: snapshot.case.trade,
        ...(snapshot.case.postalCode ? { postalCode: snapshot.case.postalCode } : {}),
        limit: Number(str(args, "limit") ?? 3),
        ...(args.flags["independent-only"] ? { independentOnly: true } : {}),
      });
      const payload = presentProviders(caseId, matches, await providers.notice());
      printPayload(payload);
      for (const match of matches) {
        process.stdout.write(`  ${c(BOLD, match.provider.name)}  ${c(DIM, match.provider.id)}\n`);
        for (const reason of match.reasons) process.stdout.write(`    ${c(DIM, reason)}\n`);
      }
      process.stdout.write("\n");
    },
  },

  quote: {
    usage: 'circa quote <caseId> --file <path> [--name "Nine Elms"] [--source second-opinion|contractor]',
    blurb: "Add a quote from a text file and parse it.",
    run: async (args) => {
      const caseId = args.positional[0];
      const file = str(args, "file");
      if (!caseId || !file) throw new Error("needs a case id and --file");
      const svc = await service();
      const text = await readFile(file, "utf8");
      const quote = await svc.addQuote({
        caseId,
        text,
        source: (str(args, "source") ?? "second-opinion").toUpperCase().replace(/-/g, "_") as "CONTRACTOR" | "SECOND_OPINION",
        ...(str(args, "name") ? { contractorName: str(args, "name")! } : {}),
      });
      process.stdout.write(
        `\n  ${quote.id}  ${quote.contractorName ?? "unnamed"}\n  ${c(DIM, `${quote.lineItems.length} line items · itemisation ${quote.itemisation?.level ?? "unparsed"}`)}\n\n`,
      );
    },
  },

  compare: {
    usage: "circa compare <caseId> [--a <quoteId>] [--b <quoteId>]",
    blurb: "Compare two quotes, and refuse to attribute the difference when the documents cannot carry it.",
    run: async (args) => {
      const caseId = args.positional[0];
      if (!caseId) throw new Error("needs a case id");
      const svc = await service();
      const { comparison, quoteA, quoteB } = await svc.compare({
        caseId,
        ...(str(args, "a") ? { quoteAId: str(args, "a")! } : {}),
        ...(str(args, "b") ? { quoteBId: str(args, "b")! } : {}),
      });
      const snapshot = (await svc.snapshot(caseId))!;
      printPayload(presentComparison(snapshot, comparison, quoteA, quoteB));
    },
  },

  accept: {
    usage: "circa accept <caseId> <quoteId>",
    blurb: "Record what was accepted. Written once, never rewritten.",
    run: async (args) => {
      const [caseId, quoteId] = args.positional;
      if (!caseId || !quoteId) throw new Error("needs a case id and a quote id");
      const svc = await service();
      const baseline = await svc.acceptScope({ caseId, quoteId });
      process.stdout.write(`\n  ${baseline.id}  accepted ${baseline.work.length} pieces of work on ${baseline.acceptedAt.slice(0, 10)}\n\n`);
    },
  },

  change: {
    usage: 'circa change <caseId> "<what they now want>" [--amount 2200]',
    blurb: "Measure a new request against what was accepted.",
    run: async (args) => {
      const [caseId, describedAs] = args.positional;
      if (!caseId || !describedAs) throw new Error("needs a case id and what they now want");
      const amount = dollars(str(args, "amount"));
      const svc = await service();
      const { review } = await svc.recordScopeChange({
        caseId,
        describedAs,
        ...(amount !== undefined ? { amountCents: toCents(amount) } : {}),
      });
      const snapshot = (await svc.snapshot(caseId))!;
      printPayload(presentChange(snapshot, review));
    },
  },

  review: {
    usage: "circa review <caseId> [<changeId>]",
    blurb: "Re-run the review of a change already on file.",
    run: async (args) => {
      const [caseId, changeId] = args.positional;
      if (!caseId) throw new Error("needs a case id");
      const svc = await service();
      const review = await svc.reviewChange({ caseId, ...(changeId ? { changeId } : {}) });
      const snapshot = (await svc.snapshot(caseId))!;
      printPayload(presentChange(snapshot, review));
    },
  },

  dossier: {
    usage: "circa dossier <caseId>",
    blurb: "The whole record: quotes, what was accepted, changes, timeline.",
    run: async (args) => {
      const caseId = args.positional[0];
      if (!caseId) throw new Error("needs a case id");
      const svc = await service();
      const snapshot = await svc.snapshot(caseId);
      if (!snapshot) throw new Error(`no repair on record under ${caseId}`);
      const payload = presentDossier(snapshot, runVerification(snapshot));
      printPayload(payload);
      for (const event of snapshot.timeline) {
        process.stdout.write(`  ${c(DIM, event.at.slice(0, 16).replace("T", " "))}  ${event.summary}\n`);
      }
      process.stdout.write("\n");
    },
  },

  list: {
    usage: "circa list",
    blurb: "Every repair on record.",
    run: async () => {
      const svc = await service();
      const cases = await svc.list(userId());
      if (cases.length === 0) {
        process.stdout.write("\n  Nothing on record.\n\n");
        return;
      }
      process.stdout.write("\n");
      for (const item of [...cases].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
        process.stdout.write(
          `  ${item.id}  ${c(DIM, item.status.toLowerCase().replace(/_/g, " ").padEnd(26))}${item.issueSummary.slice(0, 60)}\n`,
        );
      }
      process.stdout.write("\n");
    },
  },

  delete: {
    usage: "circa delete <caseId>",
    blurb: "Delete a repair and everything recorded against it.",
    run: async (args) => {
      const caseId = args.positional[0];
      if (!caseId) throw new Error("needs a case id");
      const svc = await service();
      const deleted = await svc.deleteCase(caseId);
      process.stdout.write(
        deleted
          ? `\n  Deleted. The quotes, the accepted scope and the whole timeline are gone.\n\n`
          : `\n  Nothing on record under ${caseId}.\n\n`,
      );
    },
  },

  say: {
    usage: 'circa say "<what you would say to Alexa>" [--case <caseId>]',
    blurb: "Run the deterministic planner over an utterance and execute what it plans, through a real MCP client.",
    run: async (args) => {
      const utterance = args.positional[0];
      if (!utterance) throw new Error("say something");
      const svc = await service();
      const caseId = str(args, "case");
      const snapshot = caseId ? await svc.snapshot(caseId) : undefined;
      if (caseId && !snapshot) throw new Error(`no repair on record under ${caseId}`);

      const state: PlannerState = {
        ...(caseId ? { caseId } : {}),
        hasOffer: (snapshot?.offers.length ?? 0) > 0,
        quoteCount: snapshot?.quotes.length ?? 0,
        hasBaseline: Boolean(snapshot?.baseline),
        ...(snapshot?.quotes.at(-1) ? { lastQuoteId: snapshot.quotes.at(-1)!.id } : {}),
      };
      const planned = plan(utterance, state);

      process.stdout.write(`\n  ${c(BOLD, "You")}    ${utterance}\n`);
      if (planned.calls.length === 0) {
        // A planner that has not understood says so. Reaching for an adjacent
        // tool is the failure mode that costs somebody money.
        process.stdout.write(`\n  ${c(CYAN, planned.clarification ?? "I did not follow that.")}\n\n`);
        return;
      }

      // The planned calls go over the wire, against the real server, because the
      // question this command answers is what Alexa+ would get back.
      const context = await createContext(process.env, { service: svc });
      const server = await startHttpServer(context, { port: 0 });
      const client = new Client({ name: "circa-cli", version: "0.1.0" });
      const transport = new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`));
      try {
        await client.connect(transport);
        for (const call of planned.calls) {
          process.stdout.write(`  ${c(DIM, `plan: ${call.tool}  (${call.matched})`)}\n`);
          const result = await client.callTool({ name: call.tool as ToolName, arguments: call.arguments });
          if (result.isError) {
            process.stdout.write(`  ${c(YELLOW, (result.content as { text: string }[])[0]?.text ?? "failed")}\n\n`);
            continue;
          }
          const payload = result.structuredContent as ViewPayload | undefined;
          if (payload?.speech) printPayload(payload);
          else process.stdout.write(`\n  ${c(CYAN, (result.content as { text: string }[])[0]?.text ?? "")}\n\n`);
        }
      } finally {
        await client.close().catch(() => undefined);
        await server.close();
      }
    },
  },
};

function usage(): string {
  const lines = ["", `${c(BOLD, "circa")} — the same repair record Alexa+ reads, from a terminal`, ""];
  for (const [name, command] of Object.entries(COMMANDS)) {
    lines.push(`  ${c(BOLD, name.padEnd(10))}${command.blurb}`);
    lines.push(`  ${c(DIM, `          ${command.usage}`)}`);
  }
  lines.push(
    "",
    c(DIM, "  The store is chosen by CIRCA_STORE (file by default, then memory or dynamodb)."),
    c(DIM, "  `pnpm check` prints which one is live. No AWS account is needed for any of this."),
    "",
  );
  return lines.join("\n");
}

async function main(): Promise<void> {
  const [name, ...rest] = process.argv.slice(2);
  if (!name || name === "help" || name === "--help") {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const command = COMMANDS[name];
  if (!command) {
    process.stderr.write(`${c(YELLOW, `no command called ${name}`)}\n${usage()}\n`);
    process.exit(2);
  }
  await command.run(parseArgs(rest));
}

main().catch((error: unknown) => {
  process.stderr.write(`\n  ${c(YELLOW, error instanceof Error ? error.message : String(error))}\n\n`);
  process.exit(1);
});
