import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { assertSafeLanguage } from "#schema";
import { guessTrade, plan, type PlannerState } from "../../agent/src/planner.js";
import { INDEPENDENT_QUOTE, ITEMISED_REQUOTE } from "../../../tools/demo/src/script.js";

/**
 * CIRCA on today's Alexa, as a classic custom skill.
 *
 * On Alexa+ a model reads the MCP tool schemas and decides what to call. A
 * classic skill has no such model: Alexa's interaction model resolves the
 * utterance to an intent, and this file is the host that turns each intent
 * into calls on the same MCP server, through the SDK's own `Client`. It holds
 * no product logic. Every sentence about a repair is the tool result's own
 * `content`, exactly as the simulator reads it, so the skill and the add-on
 * cannot disagree about what a result says.
 *
 * Nothing about the repair lives in the Alexa session. The case is read back
 * from the record with `list_repair_cases` and `get_repair_dossier` on every
 * turn, so a conversation that stops and starts again a fortnight later
 * continues from what was recorded, not from what a session remembered. The
 * session keeps only what no tool returns twice: the assessor last offered,
 * the change last recorded, and the customer's own words from earlier turns.
 */

// ── the Alexa request and response, as much of them as this skill reads ─────

export interface AlexaSlot {
  name: string;
  value?: string;
  resolutions?: {
    resolutionsPerAuthority?: { status?: { code?: string }; values?: { value: { name: string; id: string } }[] }[];
  };
}

export interface AlexaRequestEnvelope {
  version: string;
  session?: {
    new?: boolean;
    sessionId?: string;
    application?: { applicationId: string };
    user?: { userId: string };
    attributes?: Record<string, unknown>;
  };
  context?: { System?: { application?: { applicationId: string }; user?: { userId: string } } };
  request: {
    type: string;
    requestId?: string;
    timestamp?: string;
    locale?: string;
    intent?: { name: string; confirmationStatus?: string; slots?: Record<string, AlexaSlot> };
    reason?: string;
  };
}

export interface AlexaResponseEnvelope {
  version: "1.0";
  sessionAttributes?: Record<string, unknown>;
  response: {
    outputSpeech?: { type: "SSML"; ssml: string };
    card?: { type: "Simple"; title: string; content: string };
    reprompt?: { outputSpeech: { type: "SSML"; ssml: string } };
    shouldEndSession?: boolean;
  };
}

/** What the session carries between turns. Ids and the customer's words, never the repair itself. */
export interface Pointer {
  caseId?: string;
  providerId?: string;
  changeId?: string;
  /** What the customer said is wrong, from the turn that opened the case. */
  issue?: string;
  foundBy?: "DOOR_KNOCK";
  /** The offer as the customer said it, for the deadline it named. */
  offer?: string;
  pendingDelete?: boolean;
}

/** One tool call and what came back, kept so a test or a transcript can show the wire. */
export interface ToolTrace {
  tool: string;
  arguments: Record<string, unknown>;
  speech: string;
  isError: boolean;
  read?: boolean;
  structured?: Record<string, unknown>;
}

export interface SkillTurn {
  response: AlexaResponseEnvelope;
  calls: ToolTrace[];
}

interface RecordView {
  caseId: string;
  status: string;
  title: string;
  quotes: { id: string; source: string; name: string | null; itemisation: string | null }[];
  hasBaseline: boolean;
}

const WELCOME = "This is CIRCA. Tell me what a contractor has offered, and I will check what can be checked before money moves.";
const HELP =
  "You can tell me what a contractor says and what they want for it, ask me where we stand, get an independent assessment, compare two quotes, or check a later request for more money against what you agreed.";
const REPROMPT = "What would you like to do next?";

// ── the host ─────────────────────────────────────────────────────────────────

export class CircaSkill {
  private readonly calls: ToolTrace[] = [];

  constructor(
    private readonly client: Client,
    private readonly pointer: Pointer,
  ) {}

  /** Call one tool on the MCP server and keep what it said. `read` marks a call made to find the case, not to answer. */
  private async call(tool: string, args: Record<string, unknown>, read = false): Promise<ToolTrace> {
    const result = await this.client.callTool({ name: tool, arguments: args });
    const speech = ((result.content ?? []) as { type: string; text?: string }[])
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join(" ");
    const trace: ToolTrace = {
      tool,
      arguments: args,
      speech,
      isError: result.isError === true,
      ...(read ? { read: true } : {}),
      ...(result.structuredContent ? { structured: result.structuredContent as Record<string, unknown> } : {}),
    };
    this.calls.push(trace);
    return trace;
  }

  /** The repair this conversation is about, read from the record rather than from the session. */
  private async record(): Promise<RecordView | undefined> {
    let caseId = this.pointer.caseId;
    if (!caseId) {
      const listed = await this.call("list_repair_cases", {}, true);
      const cases = (listed.structured?.["cases"] ?? []) as { id: string }[];
      caseId = cases[0]?.id;
      if (!caseId) return undefined;
    }
    const dossier = await this.call("get_repair_dossier", { caseId }, true);
    if (dossier.isError || !dossier.structured) {
      delete this.pointer.caseId;
      return undefined;
    }
    this.pointer.caseId = caseId;
    const structured = dossier.structured;
    return {
      caseId,
      status: String(structured["status"] ?? ""),
      title: String(structured["headline"] ?? ""),
      quotes: (structured["quotes"] ?? []) as RecordView["quotes"],
      hasBaseline: structured["baseline"] !== undefined,
    };
  }

  private plannerState(view: RecordView): PlannerState {
    return {
      caseId: view.caseId,
      hasOffer: view.quotes.some((q) => q.source === "CONTRACTOR") || view.status !== "NEW",
      quoteCount: view.quotes.length,
      hasBaseline: view.hasBaseline,
      ...(this.pointer.providerId ? { lastProviderId: this.pointer.providerId } : {}),
    };
  }

  async handle(envelope: AlexaRequestEnvelope): Promise<SkillTurn> {
    const response = await this.dispatch(envelope);
    return { response, calls: this.calls };
  }

  private async dispatch(envelope: AlexaRequestEnvelope): Promise<AlexaResponseEnvelope> {
    const { request } = envelope;
    if (request.type === "SessionEndedRequest") return { version: "1.0", response: {} };
    if (request.type === "LaunchRequest") return this.launch();
    if (request.type !== "IntentRequest" || !request.intent) return this.say(HELP);

    const intent = request.intent;
    const slot = (name: string): string | undefined => intent.slots?.[name]?.value?.trim() || undefined;
    const slotId = (name: string): string | undefined =>
      intent.slots?.[name]?.resolutions?.resolutionsPerAuthority?.find((a) => a.status?.code === "ER_SUCCESS_MATCH")
        ?.values?.[0]?.value.id;

    if (this.pointer.pendingDelete && intent.name !== "AMAZON.YesIntent") delete this.pointer.pendingDelete;

    switch (intent.name) {
      case "CheckRepairIntent":
        return this.open(slot("issue"));
      case "DoorKnockIntent":
        return this.open(slot("issue"), "DOOR_KNOCK");
      case "OfferIntent":
        return this.money(slot("offer") ? `they want ${slot("offer")}` : undefined);
      case "ScopeChangeIntent":
        return this.money(slot("change") ? `they want another ${slot("change")}` : undefined);
      case "AnswerIntent":
        return this.answer(slotId("shown"), slotId("written"));
      case "SecondOpinionIntent":
        return this.secondOpinion();
      case "SendRequestIntent":
        return this.sendRequest();
      case "AssessmentBackIntent":
        return this.addDocument("SECOND_OPINION");
      case "RequoteIntent":
        return this.addDocument("CONTRACTOR");
      case "CompareIntent":
        return this.compare();
      case "AcceptIntent":
        return this.accept(slotId("which"));
      case "PutInWritingIntent":
        return this.documentChange();
      case "StatusIntent":
        return this.onCase((view) => this.call("get_verification_status", { caseId: view.caseId }));
      case "DossierIntent":
        return this.onCase((view) => this.call("get_repair_dossier", { caseId: view.caseId }));
      case "ListRepairsIntent":
        return this.speak([await this.call("list_repair_cases", {})]);
      case "DeleteRepairIntent":
        return this.confirmDelete();
      case "AMAZON.YesIntent":
        return this.pointer.pendingDelete ? this.delete() : this.say(HELP);
      case "AMAZON.NoIntent":
        return this.say(this.pointer.pendingDelete === undefined ? HELP : "I have kept it.");
      case "AMAZON.HelpIntent":
        return this.say(HELP);
      case "AMAZON.StopIntent":
      case "AMAZON.CancelIntent":
        return this.say("The record is kept. Open CIRCA again when something changes.", { end: true });
      case "AMAZON.NavigateHomeIntent":
        return this.say("The record is kept.", { end: true });
      default:
        // AMAZON.FallbackIntent: say so, rather than reaching for an adjacent tool.
        return this.say(`I did not follow that. ${HELP}`);
    }
  }

  // ── intents ───────────────────────────────────────────────────────────────

  private async launch(): Promise<AlexaResponseEnvelope> {
    const listed = await this.call("list_repair_cases", {});
    const cases = (listed.structured?.["cases"] ?? []) as { id: string }[];
    if (cases.length === 0) return this.say(WELCOME);
    this.pointer.caseId = cases[0]!.id;
    return this.speak([listed], { lead: "This is CIRCA.", tail: "Tell me what has happened since, or ask where we stand." });
  }

  private async open(issue: string | undefined, foundBy?: "DOOR_KNOCK"): Promise<AlexaResponseEnvelope> {
    if (!issue) return this.say("Tell me what they say is wrong, for example: a roofer says the flashing has failed.");
    const trade = guessTrade(issue);
    const opened = await this.call("start_repair_case", {
      issueSummary: sentence(issue),
      ...(trade !== "unknown" ? { trade } : {}),
    });
    this.pointer.caseId = opened.structured?.["caseId"] as string | undefined;
    this.pointer.issue = sentence(issue);
    delete this.pointer.providerId;
    delete this.pointer.changeId;
    delete this.pointer.offer;
    if (foundBy) this.pointer.foundBy = foundBy;
    else delete this.pointer.foundBy;
    return this.speak([opened]);
  }

  /**
   * "They want ..." is an offer before a scope is accepted and a change order
   * after it. Alexa's model cannot know which, and the record can, so the
   * record decides, as the planner's own state does.
   */
  private async money(utterance: string | undefined): Promise<AlexaResponseEnvelope> {
    if (!utterance) return this.say("Tell me what they want, and what for.");
    const view = await this.record();
    if (!view) return this.say("Tell me what the repair is first, and I will open a record for it.");
    const planned = plan(utterance, this.plannerState(view)).calls.find(
      (c) => c.tool === "capture_offer" || c.tool === "record_scope_change",
    );
    if (!planned) return this.say("I did not catch an amount there. Tell me what they want, in dollars.");

    if (planned.tool === "capture_offer") {
      const args: Record<string, unknown> = {
        ...planned.arguments,
        description: [this.pointer.issue, sentence(utterance)].filter(Boolean).join(" "),
        ...(tradeOf(this.pointer.issue) ? { trade: tradeOf(this.pointer.issue) } : {}),
        ...(this.pointer.foundBy ? { contractorFoundBy: this.pointer.foundBy } : {}),
      };
      this.pointer.offer = utterance;
      return this.speak([await this.call("capture_offer", args)]);
    }

    const recorded = await this.call("record_scope_change", { ...planned.arguments, describedAs: sentence(utterance) });
    const changeId = recorded.structured?.["changeId"];
    if (typeof changeId === "string") this.pointer.changeId = changeId;
    return this.speak([recorded]);
  }

  private async answer(shown: string | undefined, written: string | undefined): Promise<AlexaResponseEnvelope> {
    if (!shown && !written) return this.say("I did not follow that. Have you seen the damage, and is there anything in writing?");
    return this.onCase((view) => {
      const args: Record<string, unknown> = { caseId: view.caseId };
      if (shown) args["damageShownToCustomer"] = shown === "SHOWN";
      if (written) args["writtenScopeProvided"] = written === "WRITTEN";
      // The deadline is one the customer named when they gave the offer: "three thousand of it today".
      const deadline = deadlineOf(this.pointer.offer);
      if (deadline) args["decisionRequestedBy"] = deadline;
      return this.call("answer_verification_question", args);
    });
  }

  private async secondOpinion(): Promise<AlexaResponseEnvelope> {
    return this.onCase(async (view) => {
      const scope = await this.call("structure_scope", { caseId: view.caseId });
      if (scope.isError) return scope;
      const found = await this.call("find_independent_professionals", { caseId: view.caseId, limit: 3 });
      const first = (found.structured?.["matches"] as { id: string }[] | undefined)?.[0];
      if (first) this.pointer.providerId = first.id;
      return [scope, found];
    });
  }

  private async sendRequest(): Promise<AlexaResponseEnvelope> {
    return this.onCase(async (view) => {
      let providerId = this.pointer.providerId;
      if (!providerId) {
        const found = await this.call("find_independent_professionals", { caseId: view.caseId, limit: 3 });
        providerId = (found.structured?.["matches"] as { id: string }[] | undefined)?.[0]?.id;
        if (!providerId) return found;
      }
      return this.call("request_second_opinion", { caseId: view.caseId, providerId });
    });
  }

  /**
   * A voice turn cannot carry a document. In the product a quote arrives as a
   * photo or PDF the customer uploads; in this skill the two documents of the
   * demonstrated case are the demo script's own fixtures, the same text that
   * `pnpm demo` and the simulator send to `add_quote`.
   */
  private async addDocument(source: "SECOND_OPINION" | "CONTRACTOR"): Promise<AlexaResponseEnvelope> {
    return this.onCase((view) =>
      this.call("add_quote", {
        caseId: view.caseId,
        source,
        contractorName: source === "SECOND_OPINION" ? "Nine Elms Exterior Surveys" : "Apex Exteriors",
        text: source === "SECOND_OPINION" ? INDEPENDENT_QUOTE : ITEMISED_REQUOTE,
      }),
    );
  }

  private async compare(): Promise<AlexaResponseEnvelope> {
    const view = await this.record();
    if (!view) return this.say("There is no repair on record to compare quotes for.");
    if (view.quotes.length < 2) {
      return this.say(
        `I have ${view.quotes.length === 1 ? "one quote" : "no quotes"} on file for this repair. A comparison needs two.`,
      );
    }
    const contractor = view.quotes.filter((q) => q.source === "CONTRACTOR");
    const independent = view.quotes.filter((q) => q.source !== "CONTRACTOR");
    // With a revised quote on file, the comparison is the latest from each side, which is the one the customer asked for.
    const args: Record<string, unknown> = { caseId: view.caseId };
    if (contractor.length > 1 && independent.length > 0) {
      args["quoteAId"] = contractor.at(-1)!.id;
      args["quoteBId"] = independent.at(-1)!.id;
    }
    return this.speak([await this.call("compare_quotes", args)]);
  }

  private async accept(which: string | undefined): Promise<AlexaResponseEnvelope> {
    if (!which) return this.say("Which quote: the first one, or the second?");
    const view = await this.record();
    if (!view) return this.say("There is no repair on record.");
    const pool = view.quotes.filter((q) => (which === "FIRST" ? q.source === "CONTRACTOR" : q.source !== "CONTRACTOR"));
    const chosen = pool.at(-1);
    if (!chosen) return this.say(`There is no ${which === "FIRST" ? "contractor's" : "independent"} quote on file to accept.`);
    return this.speak([await this.call("accept_scope", { caseId: view.caseId, quoteId: chosen.id })]);
  }

  private async documentChange(): Promise<AlexaResponseEnvelope> {
    return this.onCase(async (view) => {
      let changeId = this.pointer.changeId;
      if (!changeId) {
        const review = await this.call("review_scope_change", { caseId: view.caseId });
        changeId = review.structured?.["changeId"] as string | undefined;
        if (!changeId) return review;
      }
      return this.call("set_change_status", { caseId: view.caseId, changeId, status: "DOCUMENTED" });
    });
  }

  private async confirmDelete(): Promise<AlexaResponseEnvelope> {
    const view = await this.record();
    if (!view) return this.say("There is no repair on record to delete.");
    this.pointer.pendingDelete = true;
    return this.say(
      "That deletes the record of this repair: the quotes, the accepted scope and the whole timeline, and I cannot get it back. Shall I delete it?",
      { reprompt: "Shall I delete it? Say yes or no." },
    );
  }

  private async delete(): Promise<AlexaResponseEnvelope> {
    delete this.pointer.pendingDelete;
    const view = await this.record();
    if (!view) return this.say("There is no repair on record to delete.");
    const deleted = await this.call("delete_repair_case", { caseId: view.caseId });
    for (const key of Object.keys(this.pointer)) delete (this.pointer as Record<string, unknown>)[key];
    return this.speak([deleted]);
  }

  // ── shared ────────────────────────────────────────────────────────────────

  private async onCase(
    run: (view: RecordView) => Promise<ToolTrace | ToolTrace[]>,
  ): Promise<AlexaResponseEnvelope> {
    const view = await this.record();
    if (!view) return this.say("There is no repair on record yet. Tell me what a contractor has offered, and I will open one.");
    const traces = await run(view);
    return this.speak(Array.isArray(traces) ? traces : [traces]);
  }

  /** Speak what the tools said, and draw the last result's card. */
  private speak(traces: ToolTrace[], frame: { lead?: string; tail?: string } = {}): AlexaResponseEnvelope {
    const spoken = [frame.lead, ...traces.map((t) => t.speech), frame.tail].filter(Boolean).join(" ");
    const last = [...traces].reverse().find((t) => t.structured && typeof t.structured["headline"] === "string");
    const card = last?.structured ? cardOf(last.structured) : undefined;
    return this.say(spoken, card ? { card } : {});
  }

  private say(
    text: string,
    options: { end?: boolean; card?: { title: string; content: string }; reprompt?: string } = {},
  ): AlexaResponseEnvelope {
    const safe = assertSafeLanguage(text);
    return {
      version: "1.0",
      sessionAttributes: { circa: { ...this.pointer } },
      response: {
        outputSpeech: { type: "SSML", ssml: ssml(safe) },
        ...(options.card ? { card: { type: "Simple", ...options.card } } : {}),
        ...(options.end ? {} : { reprompt: { outputSpeech: { type: "SSML", ssml: ssml(options.reprompt ?? REPROMPT) } } }),
        shouldEndSession: options.end === true,
      },
    };
  }
}

/** The card is the MCP Apps view's rows, as text: the same rows, so the screen cannot say more than the voice. */
function cardOf(payload: Record<string, unknown>): { title: string; content: string } {
  const rows = (payload["rows"] ?? []) as { label: string; value: string; attention?: boolean }[];
  const lines = rows.map((r) => `${r.attention ? "! " : ""}${r.label}: ${r.value}`);
  if (typeof payload["refusal"] === "string") lines.push("", payload["refusal"]);
  return { title: String(payload["headline"]), content: lines.join("\n") || String(payload["speech"] ?? "") };
}

function ssml(text: string): string {
  const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<speak>${escaped}</speak>`;
}

function sentence(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  const capitalised = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capitalised) ? capitalised : `${capitalised}.`;
}

function tradeOf(issue: string | undefined): string | undefined {
  const guessed = issue ? guessTrade(issue) : "unknown";
  return guessed === "unknown" ? undefined : guessed;
}

function deadlineOf(offer: string | undefined): string | undefined {
  if (!offer) return undefined;
  if (/\b(?:right away|immediately|right now)\b/i.test(offer)) return "IMMEDIATELY";
  if (/\b(?:today|tonight)\b/i.test(offer)) return "TODAY";
  if (/\bthis week\b/i.test(offer)) return "THIS_WEEK";
  return undefined;
}

/** Read the session's pointer back, keeping only the fields this skill writes. */
export function pointerFrom(envelope: AlexaRequestEnvelope): Pointer {
  if (envelope.session?.new) return {};
  const raw = (envelope.session?.attributes?.["circa"] ?? {}) as Record<string, unknown>;
  const pointer: Pointer = {};
  for (const key of ["caseId", "providerId", "changeId", "issue", "offer"] as const) {
    if (typeof raw[key] === "string") pointer[key] = raw[key] as string;
  }
  if (raw["foundBy"] === "DOOR_KNOCK") pointer.foundBy = "DOOR_KNOCK";
  if (raw["pendingDelete"] === true) pointer.pendingDelete = true;
  return pointer;
}
