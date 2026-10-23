import { createRequire } from "node:module";
import path from "node:path";
import { CONVERSATION, type ConversationTurn } from "./conversation.js";
import type { AlexaRequestEnvelope, AlexaResponseEnvelope } from "./skill.js";

/**
 * The demonstrated conversation, put into Alexa's request format by a client
 * this repository did not write.
 *
 * Bespoken's Virtual Alexa (`virtual-alexa`, Apache-2.0) reads the skill's
 * interaction model, resolves each sentence to an intent and its slots the way
 * the model's samples allow, builds the request envelope with the session
 * attributes the skill returned last turn, and hands it to a handler. The
 * handler is either the skill in-process (`tests/alexa-skill.test.ts`) or the
 * deployed Lambda (`pnpm alexa:run --lambda`). Either way the words are the
 * conversation's and the routing is the interaction model's.
 */

const require = createRequire(import.meta.url);
const { VirtualAlexa } = require("virtual-alexa") as {
  VirtualAlexa: { Builder: () => VirtualAlexaBuilder };
};

interface VirtualAlexaBuilder {
  handler(fn: (event: unknown, context: unknown, callback?: (e: unknown, r?: unknown) => void) => unknown): VirtualAlexaBuilder;
  interactionModelFile(file: string): VirtualAlexaBuilder;
  locale(locale: string): VirtualAlexaBuilder;
  create(): { launch(): Promise<AlexaResponseEnvelope>; utter(text: string): Promise<AlexaResponseEnvelope>; endSession(): Promise<unknown> };
}

export const MODEL_FILE = path.resolve("apps/alexa-skill/skill-package/interactionModels/custom/en-US.json");

export interface VirtualTurn {
  turn: ConversationTurn;
  /** The envelope Virtual Alexa built and sent. */
  request: AlexaRequestEnvelope;
  response: AlexaResponseEnvelope;
  resolved: string;
  slots: Record<string, string>;
  speech: string;
  problems: string[];
  ms: number;
}

export function speechOf(response: AlexaResponseEnvelope): string {
  return (response.response?.outputSpeech?.ssml ?? "").replace(/^<speak>|<\/speak>$/g, "").replace(/&amp;/g, "&");
}

export async function runVirtual(
  handle: (envelope: AlexaRequestEnvelope) => Promise<AlexaResponseEnvelope>,
  turns: readonly ConversationTurn[] = CONVERSATION,
): Promise<VirtualTurn[]> {
  let last: AlexaRequestEnvelope | undefined;
  const alexa = VirtualAlexa.Builder()
    .handler((event, _context, callback) => {
      last = event as AlexaRequestEnvelope;
      const answer = handle(last);
      if (callback) answer.then((r) => callback(null, r), (e) => callback(e));
      return answer;
    })
    .interactionModelFile(MODEL_FILE)
    .locale("en-US")
    .create();

  const out: VirtualTurn[] = [];
  for (const turn of turns) {
    const started = performance.now();
    if (turn.newSession) await alexa.endSession().catch(() => undefined);
    const response = turn.request === "LaunchRequest" ? await alexa.launch() : await alexa.utter(turn.said);
    const ms = Math.round(performance.now() - started);
    const request = last!;
    const resolved = request.request.type === "IntentRequest" ? (request.request.intent?.name ?? "IntentRequest") : request.request.type;
    const slots = Object.fromEntries(
      Object.entries(request.request.intent?.slots ?? {})
        .filter(([, s]) => s.value !== undefined)
        .map(([name, s]) => [name, s.value!]),
    );
    const expected = turn.request === "LaunchRequest" ? "LaunchRequest" : turn.request.intent;
    const speech = speechOf(response);
    const problems: string[] = [];
    if (resolved !== expected) problems.push(`resolved ${resolved}, expected ${expected}`);
    for (const fragment of turn.expect ?? []) if (!speech.includes(fragment)) problems.push(`answer lacks "${fragment}"`);
    if (/I could not do that/.test(speech)) problems.push("a tool returned an error");
    out.push({ turn, request, response, resolved, slots, speech, problems, ms });
  }
  return out;
}
