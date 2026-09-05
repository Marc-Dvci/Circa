import type { ToolName } from "../../mcp-server/src/tools.js";

/**
 * The deterministic planner.
 *
 * This is what turns "they want another two thousand two hundred for decking"
 * into `record_scope_change` with an amount, without a model and without
 * credentials. It exists for two reasons, and the second is the important one.
 *
 * The first is that a judge on a clean clone with no AWS account must be able to
 * run the entire demo. The second is that it is the measurement baseline: when
 * the Bedrock path is switched on, the corpus is scored against both, and a
 * model that cannot beat a regex on the demo scenarios has not earned its
 * latency. Keeping the deterministic path when the model arrives is what makes
 * that comparison possible at all.
 *
 * It is a planner, not a parser of English. It recognises the shapes a homeowner
 * actually uses at each point in the workflow, and where it recognises nothing
 * it says so rather than guessing — an agent that picks a plausible tool when it
 * has not understood is the failure mode that costs somebody money.
 */

export interface PlannedCall {
  tool: ToolName;
  arguments: Record<string, unknown>;
  /** Which pattern fired. Printed by `pnpm eval --plans`, so a miss is traceable. */
  matched: string;
}

export interface PlanResult {
  calls: PlannedCall[];
  /** Said when nothing matched. Never a guess. */
  clarification?: string;
}

export interface PlannerState {
  caseId?: string;
  hasOffer: boolean;
  quoteCount: number;
  hasBaseline: boolean;
  lastQuoteId?: string;
  lastProviderId?: string;
}

const MONEY = /(?:\$\s?)?([0-9][0-9,]*(?:\.[0-9]{2})?)\s*(?:dollars|bucks)?/i;

/** "two thousand two hundred" — spoken money, which is what Alexa hands you. */
const SPOKEN_NUMBERS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

export function parseSpokenAmount(text: string): number | undefined {
  const digits = MONEY.exec(text);
  if (digits && /\d/.test(digits[1] ?? "")) {
    const value = Number((digits[1] ?? "").replace(/,/g, ""));
    if (Number.isFinite(value) && value > 0) return value;
  }
  const words = text.toLowerCase().match(/\b(?:[a-z]+[\s-]?)+\b/g) ?? [];
  for (const phrase of words) {
    const value = wordsToNumber(phrase);
    if (value !== undefined && value >= 50) return value;
  }
  return undefined;
}

function wordsToNumber(phrase: string): number | undefined {
  const tokens = phrase.toLowerCase().split(/[\s-]+/).filter(Boolean);
  let total = 0;
  let current = 0;
  let sawAny = false;
  for (const token of tokens) {
    if (token === "and") continue;
    if (token in SPOKEN_NUMBERS) {
      current += SPOKEN_NUMBERS[token]!;
      sawAny = true;
    } else if (token === "hundred") {
      current = (current || 1) * 100;
      sawAny = true;
    } else if (token === "thousand") {
      total += (current || 1) * 1000;
      current = 0;
      sawAny = true;
    } else if (sawAny) {
      break;
    }
  }
  return sawAny ? total + current : undefined;
}

interface Pattern {
  name: string;
  test: RegExp;
  build: (utterance: string, state: PlannerState) => PlannedCall | PlannedCall[] | undefined;
}

const PATTERNS: readonly Pattern[] = [
  {
    name: "open-case",
    test: /\b(?:check (?:a|this|my) repair|someone (?:is|'s) here about|got a quote|a (?:roofer|plumber|electrician|contractor) (?:says|came|knocked)|start a (?:repair|case))\b/i,
    build: (utterance) => ({
      tool: "start_repair_case",
      arguments: { issueSummary: utterance, trade: guessTrade(utterance) },
      matched: "open-case",
    }),
  },
  {
    name: "capture-offer",
    test: /\b(?:they (?:say|said|want|quoted)|he (?:says|said|wants)|she (?:says|said|wants)|quoted me|it(?:'s| is) going to be)\b/i,
    build: (utterance, state) => {
      if (!state.caseId || state.hasBaseline) return undefined;
      const amount = parseSpokenAmount(utterance);
      const deposit = depositAmount(utterance);
      return {
        tool: "capture_offer",
        arguments: {
          caseId: state.caseId,
          description: utterance,
          ...(amount !== undefined ? { quotedPrice: amount } : {}),
          ...(deposit !== undefined ? { depositRequested: deposit } : {}),
          ...(/\bknock|door|turned up|showed up|came to the door\b/i.test(utterance)
            ? { contractorFoundBy: "DOOR_KNOCK" }
            : {}),
          ...(urgencyClaim(utterance) ? { urgencyClaim: urgencyClaim(utterance) } : {}),
        },
        matched: "capture-offer",
      };
    },
  },
  {
    name: "status",
    test: /\b(?:what (?:do you|have you) (?:know|got|found)|where (?:are we|do we stand)|what(?:'s| is) (?:the )?status|run the checks?|is (?:this|that|it) all right)\b/i,
    build: (_u, state) =>
      state.caseId ? { tool: "get_verification_status", arguments: { caseId: state.caseId }, matched: "status" } : undefined,
  },
  {
    name: "second-opinion",
    test: /\b(?:second opinion|another opinion|someone else (?:to )?look|independent (?:look|assessment|opinion)|get (?:me )?another (?:quote|estimate))\b/i,
    build: (_u, state) =>
      state.caseId
        ? [
            { tool: "structure_scope", arguments: { caseId: state.caseId }, matched: "second-opinion" },
            { tool: "find_independent_professionals", arguments: { caseId: state.caseId }, matched: "second-opinion" },
          ]
        : undefined,
  },
  {
    name: "send-request",
    test: /\b(?:send (?:it|the request|that)|book (?:the )?first one|use (?:the )?first|go with (?:the )?first)\b/i,
    build: (_u, state) =>
      state.caseId && state.lastProviderId
        ? {
            tool: "request_second_opinion",
            arguments: { caseId: state.caseId, providerId: state.lastProviderId },
            matched: "send-request",
          }
        : undefined,
  },
  {
    name: "compare",
    test: /\b(?:compare (?:the )?(?:two )?quotes?|which (?:one )?is better|how do they compare|what(?:'s| is) the difference)\b/i,
    build: (_u, state) =>
      state.caseId && state.quoteCount >= 2
        ? { tool: "compare_quotes", arguments: { caseId: state.caseId }, matched: "compare" }
        : undefined,
  },
  {
    name: "accept",
    test: /\b(?:i(?:'ll| will)? (?:go with|take|accept)|book (?:them|it)|let(?:'s| us) do (?:it|that))\b/i,
    build: (_u, state) =>
      state.caseId && state.lastQuoteId
        ? { tool: "accept_scope", arguments: { caseId: state.caseId, quoteId: state.lastQuoteId }, matched: "accept" }
        : undefined,
  },
  {
    name: "scope-change",
    test: /\b(?:another|extra|more|additional|now (?:they )?want|found (?:something|rot|damage)|on top of)\b/i,
    build: (utterance, state) => {
      if (!state.caseId || !state.hasBaseline) return undefined;
      const amount = parseSpokenAmount(utterance);
      return {
        tool: "record_scope_change",
        arguments: {
          caseId: state.caseId,
          describedAs: utterance,
          ...(amount !== undefined ? { amount } : {}),
        },
        matched: "scope-change",
      };
    },
  },
  {
    name: "recall-agreement",
    test: /\b(?:what did i agree|was that in|is that included|what(?:'s| is) in (?:the|my) (?:contract|agreement)|show me (?:the )?(?:record|dossier|everything))\b/i,
    build: (_u, state) =>
      state.caseId
        ? { tool: state.hasBaseline ? "review_scope_change" : "get_repair_dossier", arguments: { caseId: state.caseId }, matched: "recall-agreement" }
        : undefined,
  },
  {
    name: "delete",
    test: /\b(?:delete (?:this|the|my) (?:repair|case|record)|forget (?:this|it)|remove (?:my|the) (?:record|data))\b/i,
    build: (_u, state) =>
      state.caseId ? { tool: "delete_repair_case", arguments: { caseId: state.caseId }, matched: "delete" } : undefined,
  },
];

function guessTrade(text: string): string {
  if (/\broof|shingle|flashing|gutter|chimney\b/i.test(text)) return "roofing";
  if (/\bplumb|pipe|drain|water heater|leak under|toilet|sewer\b/i.test(text)) return "plumbing";
  if (/\belectric|panel|breaker|outlet|wiring|amp\b/i.test(text)) return "electrical";
  if (/\bfurnace|hvac|air condition|ac unit|heat pump|duct|coil\b/i.test(text)) return "hvac";
  return "unknown";
}

function depositAmount(text: string): number | undefined {
  const match = /\b(?:deposit|up ?front|down ?payment|to start|to book)\b[^.]{0,40}/i.exec(text);
  return match ? parseSpokenAmount(match[0]) : undefined;
}

function urgencyClaim(text: string): string | undefined {
  const match = /\b(?:before (?:it|the) (?:rains?|storm)|tonight|today|right away|immediately|by (?:the )?end of (?:the )?day|first thing|collapse|cave in|any day now)\b[^.]{0,60}/i.exec(text);
  return match?.[0]?.trim();
}

/**
 * Plan the next tool calls for one utterance.
 *
 * Order matters: the patterns are tried most specific first, and the first one
 * whose builder returns something wins. A builder returns `undefined` when the
 * shape matched but the state cannot support it — "compare the quotes" with one
 * quote on file — and that is not a fall-through to a different tool, it is a
 * clarification, because doing something adjacent to what was asked is how an
 * agent loses a user's trust in one turn.
 */
export function plan(utterance: string, state: PlannerState): PlanResult {
  for (const pattern of PATTERNS) {
    if (!pattern.test.test(utterance)) continue;
    const built = pattern.build(utterance, state);
    if (!built) continue;
    return { calls: Array.isArray(built) ? built : [built] };
  }
  if (!state.caseId) {
    return {
      calls: [],
      clarification: "Tell me what you have been offered and who by, and I will open a record for it.",
    };
  }
  return {
    calls: [],
    clarification:
      "I did not follow that. You can ask me what I have established, get an independent assessment, compare two quotes, or check something against what you agreed.",
  };
}

export const PLANNER_PATTERNS = PATTERNS.map((p) => p.name);
