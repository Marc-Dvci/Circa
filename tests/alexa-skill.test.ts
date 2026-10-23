import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryCaseRepository } from "#store";
import { CONVERSATION, INVOCATION, type ConversationTurn } from "../apps/alexa-skill/src/conversation.js";
import { circaUserId, connect, handleEnvelope } from "../apps/alexa-skill/src/lambda.js";
import type { AlexaRequestEnvelope, AlexaResponseEnvelope, ToolTrace } from "../apps/alexa-skill/src/skill.js";
import { runVirtual } from "../apps/alexa-skill/src/virtual.js";
import { TOOL_NAMES } from "../apps/mcp-server/src/tools.js";

/**
 * The classic custom skill, driven turn by turn as Alexa would drive it.
 *
 * Each turn is the IntentRequest that `apps/alexa-skill/src/conversation.ts`
 * names, sent through the Lambda's own entry path to the same MCP server over
 * the SDK client, against a memory store. The session attributes the skill
 * returns are sent back on the next turn, as Alexa does, and a turn marked
 * `newSession` drops them, so the second half of the arc has to find the case
 * in the record. The last block hands the words, not the intents, to
 * Bespoken's Virtual Alexa, which resolves them against the interaction model
 * and builds the envelopes itself.
 */

const MODEL = JSON.parse(
  readFileSync(path.resolve("apps/alexa-skill/skill-package/interactionModels/custom/en-US.json"), "utf8"),
) as {
  interactionModel: {
    languageModel: {
      invocationName: string;
      intents: { name: string; slots?: { name: string; type: string }[]; samples: string[] }[];
      types: { name: string; values: { id: string; name: { value: string; synonyms?: string[] } }[] }[];
    };
  };
};
const LANGUAGE = MODEL.interactionModel.languageModel;
const SKILL_ID = "amzn1.ask.skill.test";

function envelope(turn: ConversationTurn, attributes: Record<string, unknown> | undefined, isNew: boolean): AlexaRequestEnvelope {
  const user = { userId: "amzn1.ask.account.TESTUSER" };
  const application = { applicationId: SKILL_ID };
  const base = {
    version: "1.0",
    session: { new: isNew, sessionId: "s", application, user, ...(attributes ? { attributes } : {}) },
    context: { System: { application, user } },
  };
  if (turn.request === "LaunchRequest") return { ...base, request: { type: "LaunchRequest", locale: "en-US" } };
  const slots = Object.fromEntries(
    Object.entries(turn.request.slots ?? {}).map(([name, slot]) => [
      name,
      {
        name,
        value: slot.value,
        ...(slot.id
          ? { resolutions: { resolutionsPerAuthority: [{ status: { code: "ER_SUCCESS_MATCH" }, values: [{ value: { name: slot.value, id: slot.id } }] }] } }
          : {}),
      },
    ]),
  );
  return {
    ...base,
    request: { type: "IntentRequest", locale: "en-US", intent: { name: turn.request.intent, confirmationStatus: "NONE", slots } },
  };
}

function spoken(response: AlexaResponseEnvelope): string {
  return (response.response.outputSpeech?.ssml ?? "").replace(/^<speak>|<\/speak>$/g, "").replace(/&amp;/g, "&");
}

async function runConversation(): Promise<{ turn: ConversationTurn; response: AlexaResponseEnvelope; calls: ToolTrace[] }[]> {
  const repository = new MemoryCaseRepository();
  const open = (userId: string) => connect(userId, { repository, env: {} as NodeJS.ProcessEnv });
  const out: { turn: ConversationTurn; response: AlexaResponseEnvelope; calls: ToolTrace[] }[] = [];
  let attributes: Record<string, unknown> | undefined;
  for (const turn of CONVERSATION) {
    const isNew = turn.newSession === true;
    const { response, calls } = await handleEnvelope(envelope(turn, isNew ? undefined : attributes, isNew), open);
    attributes = response.sessionAttributes;
    out.push({ turn, response, calls });
  }
  return out;
}

describe("the interaction model", () => {
  it("has an invocation name Alexa accepts", () => {
    const name = LANGUAGE.invocationName;
    expect(name).toBe(INVOCATION);
    expect(name).toMatch(/^[a-z ]+$/);
    expect(name.split(" ").length).toBeGreaterThanOrEqual(2);
    for (const word of ["alexa", "amazon", "echo", "skill", "app", "open", "ask", "tell", "launch", "start", "the", "a", "to", "for"]) {
      expect(name.split(" "), `invocation name contains "${word}"`).not.toContain(word);
    }
  });

  it("gives every sample to exactly one intent, and names only declared slots", () => {
    const seen = new Map<string, string>();
    for (const intent of LANGUAGE.intents) {
      const declared = new Set((intent.slots ?? []).map((s) => s.name));
      for (const sample of intent.samples) {
        const key = sample.toLowerCase();
        expect(seen.get(key), `"${sample}" is in ${seen.get(key)} and ${intent.name}`).toBeUndefined();
        seen.set(key, intent.name);
        for (const [, slot] of sample.matchAll(/\{(\w+)\}/g)) expect(declared.has(slot!), `${intent.name}: {${slot}}`).toBe(true);
      }
    }
  });

  it("never puts AMAZON.SearchQuery beside another slot, or alone without a carrier phrase", () => {
    for (const intent of LANGUAGE.intents) {
      const search = (intent.slots ?? []).filter((s) => s.type === "AMAZON.SearchQuery").map((s) => s.name);
      if (search.length === 0) continue;
      for (const sample of intent.samples) {
        const slots = [...sample.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);
        if (slots.some((s) => search.includes(s))) {
          expect(slots, `${intent.name}: "${sample}"`).toHaveLength(1);
          expect(sample.replace(/\{\w+\}/g, "").trim().length, `${intent.name}: "${sample}" has no carrier`).toBeGreaterThan(0);
        }
      }
    }
  });

  it("declares every custom slot type it uses, with an id on every value", () => {
    const types = new Set(LANGUAGE.types.map((t) => t.name));
    for (const intent of LANGUAGE.intents) {
      for (const slot of intent.slots ?? []) if (!slot.type.startsWith("AMAZON.")) expect(types.has(slot.type), slot.type).toBe(true);
    }
    for (const type of LANGUAGE.types) for (const value of type.values) expect(value.id).toMatch(/^[A-Z_]+$/);
  });

  it("includes the built-ins every custom skill must handle", () => {
    const names = LANGUAGE.intents.map((i) => i.name);
    for (const builtIn of ["AMAZON.HelpIntent", "AMAZON.StopIntent", "AMAZON.CancelIntent", "AMAZON.NavigateHomeIntent", "AMAZON.FallbackIntent"]) {
      expect(names).toContain(builtIn);
    }
  });

  it("covers every intent the demonstrated conversation needs", () => {
    const names = new Set(LANGUAGE.intents.map((i) => i.name));
    for (const turn of CONVERSATION) if (turn.request !== "LaunchRequest") expect(names.has(turn.request.intent), turn.request.intent).toBe(true);
  });

  it("points the manifest at the Lambda and keeps the skill to the US", () => {
    const manifest = JSON.parse(readFileSync(path.resolve("apps/alexa-skill/skill-package/skill.json"), "utf8")).manifest;
    expect(manifest.apis.custom.endpoint.uri).toMatch(/^arn:aws:lambda:us-east-1:\d{12}:function:circa-alexa-skill$/);
    expect(Object.keys(manifest.publishingInformation.locales)).toEqual(["en-US"]);
    expect(manifest.publishingInformation.locales["en-US"].examplePhrases).toContain(`Alexa, open ${INVOCATION}`);
  });
});

describe("the skill, driven as Alexa drives it", () => {
  it("runs the whole demonstrated conversation through the same MCP tools", async () => {
    const turns = await runConversation();
    for (const { turn, response, calls } of turns) {
      for (const call of calls) expect(call.isError, `${turn.said}: ${call.tool} failed: ${call.speech}`).toBe(false);
      for (const fragment of turn.expect ?? []) expect(spoken(response), turn.said).toContain(fragment);
      expect(response.response.outputSpeech?.ssml).toMatch(/^<speak>[^<>]*<\/speak>$/);
    }
    const used = new Set(turns.flatMap((t) => t.calls.map((c) => c.tool)));
    // Every tool the Alexa+ add-on serves is called from today's Alexa in this one conversation, except
    // review_scope_change, which the skill reaches only when a session has lost the change it recorded.
    for (const tool of TOOL_NAMES.filter((t) => t !== "review_scope_change")) expect(used.has(tool), tool).toBe(true);
  });

  it("speaks the tool's own words, so the skill and the add-on cannot disagree", async () => {
    const turns = await runConversation();
    const payoff = turns.find((t) => t.turn.note === "THE PAYOFF.")!;
    const compare = payoff.calls.find((c) => c.tool === "compare_quotes" && !c.read)!;
    expect(spoken(payoff.response)).toBe(compare.speech);
    expect(payoff.response.response.card?.title).toBe(compare.structured?.["headline"]);
  });

  it("reads the amounts from the words of the offer", async () => {
    const turns = await runConversation();
    const offer = turns[2]!.calls.find((c) => c.tool === "capture_offer")!;
    expect(offer.arguments).toMatchObject({
      quotedPrice: 6500,
      depositRequested: 3000,
      urgencyClaim: "water could get in tonight",
      contractorFoundBy: "DOOR_KNOCK",
      trade: "roofing",
    });
    const answer = turns[3]!.calls.find((c) => c.tool === "answer_verification_question")!;
    expect(answer.arguments).toMatchObject({ damageShownToCustomer: false, writtenScopeProvided: false, decisionRequestedBy: "TODAY" });
  });

  it("finds the case in a new session from the record, not from the session", async () => {
    const turns = await runConversation();
    const relaunch = turns.findIndex((t, i) => i > 0 && t.turn.request === "LaunchRequest");
    expect(turns[relaunch]!.calls.map((c) => c.tool)).toEqual(["list_repair_cases"]);
    const change = turns[relaunch + 2]!;
    expect(change.calls.map((c) => c.tool)).toEqual(["get_repair_dossier", "record_scope_change"]);
  });

  it("asks before deleting, and deletes only on yes", async () => {
    const turns = await runConversation();
    const ask = turns.at(-2)!;
    expect(ask.calls.some((c) => c.tool === "delete_repair_case")).toBe(false);
    expect(ask.response.sessionAttributes?.["circa"]).toMatchObject({ pendingDelete: true });
    expect(turns.at(-1)!.calls.some((c) => c.tool === "delete_repair_case")).toBe(true);
  });

  it("keeps the repair out of the session: only ids and the customer's words travel", async () => {
    const turns = await runConversation();
    for (const { response } of turns) {
      const pointer = (response.sessionAttributes?.["circa"] ?? {}) as Record<string, unknown>;
      expect(Object.keys(pointer).every((k) => ["caseId", "providerId", "changeId", "issue", "foundBy", "offer", "pendingDelete"].includes(k))).toBe(true);
    }
  });

  it("stores a digest of the Alexa user id, never the id itself", () => {
    const id = circaUserId("amzn1.ask.account.TESTUSER");
    expect(id).toMatch(/^alexa_[0-9a-f]{24}$/);
    expect(id).not.toContain("TESTUSER");
  });

  it("says it did not follow rather than reaching for an adjacent tool", async () => {
    const repository = new MemoryCaseRepository();
    const { response, calls } = await handleEnvelope(
      envelope({ said: "what is the weather", request: { intent: "AMAZON.FallbackIntent" } }, undefined, true),
      (userId) => connect(userId, { repository, env: {} as NodeJS.ProcessEnv }),
    );
    expect(calls).toHaveLength(0);
    expect(spoken(response)).toContain("I did not follow that");
  });
});

describe("the skill, driven by Virtual Alexa from the words alone", () => {
  it("resolves every sentence of the conversation to the intent the skill expects, and answers it", async () => {
    const repository = new MemoryCaseRepository();
    const turns = await runVirtual(
      async (envelope) => (await handleEnvelope(envelope, (userId) => connect(userId, { repository, env: {} as NodeJS.ProcessEnv }))).response,
    );
    expect(turns).toHaveLength(CONVERSATION.length);
    for (const turn of turns) expect(turn.problems, turn.turn.said).toEqual([]);
    // The slot the planner reads amounts from carries the words, not digits.
    expect(turns[2]!.slots["offer"]).toMatch(/six thousand five hundred/);
  }, 60_000);
});
