import type { ToolName } from "../../../apps/mcp-server/src/tools.js";

/**
 * The demo, as a list of tool calls.
 *
 * One file, read by three things: `pnpm demo` prints it in a terminal, the
 * simulator replays it as a conversation, and `docs/DEMO_SCRIPT.md` is generated
 * from it. That is deliberate — a demo script kept in a document drifts from the
 * product within a week, and the first person to notice is a judge watching the
 * video next to the repository.
 *
 * The arc is the argument. The first comparison **cannot** decompose the price
 * difference, because the contractor's quote is one number for a paragraph of
 * work. CIRCA says so, and says what would make it answerable. The customer asks
 * for it itemised, and the same comparison — the same code, the same call — now
 * returns a decomposition. The product's advice changed what the product could
 * compute. That beat is the whole demo and it must not be cut for time.
 */

export interface Beat {
  /** What the customer says out loud. */
  said?: string;
  /** A jump in time, printed as a caption. */
  caption?: string;
  tool: ToolName;
  arguments: Record<string, unknown>;
  /** Substituted from earlier results: `$caseId`, `$quoteB`, `$changeId`, `$providerId`. */
  note?: string;
}

export const ITEMISED_REQUOTE = [
  "APEX EXTERIORS — revised estimate 4471",
  "",
  "Remove and replace chimney step and counter flashing ........... $1,450.00",
  "Replace 8 damaged shingles at the chimney ..................... $  520.00",
  "Replace roof decking, 6 sheets ................................ $4,030.00",
  "Seal penetrations ............................................. $  200.00",
  "Disposal and dumpster ......................................... $  300.00",
  "",
  "Total: $6,500.00",
].join("\n");

export const INDEPENDENT_QUOTE = [
  "NINE ELMS EXTERIOR SURVEYS — assessment and repair estimate",
  "",
  "Remove and replace chimney step and counter flashing ........... $1,200.00",
  "Replace 8 damaged shingles at the chimney ..................... $  400.00",
  "Seal penetrations and haul away debris ........................ $  250.00",
  "",
  "Observed: no moisture in the decking below on thermal survey.",
  "Exclusions: decking replacement, gutters",
  "Warranty: 5 years on workmanship",
  "Total: $1,850.00",
].join("\n");

export const SCRIPT: readonly Beat[] = [
  {
    said: "Alexa, check a repair for me. A roofer knocked on the door and says the flashing round the chimney has failed.",
    tool: "start_repair_case",
    arguments: {
      issueSummary: "A roofer says the chimney flashing has failed and water could get in tonight",
      trade: "roofing",
      postalCode: "02139",
    },
  },
  {
    said: "They want six thousand five hundred, three thousand of it today, and they say water could get in tonight.",
    tool: "capture_offer",
    arguments: {
      caseId: "$caseId",
      description:
        "They knocked on the door and said the flashing around the chimney has failed and the shingles near it need replacing, and maybe the decking underneath",
      companyName: "Apex Exteriors",
      quotedPrice: 6500,
      depositRequested: 3000,
      contractorFoundBy: "DOOR_KNOCK",
      urgencyClaim: "water could get in tonight",
    },
    note: "Two conditions fire here, and neither is about the contractor.",
  },
  {
    said: "No, I have not seen it, and there is nothing in writing.",
    tool: "answer_verification_question",
    arguments: {
      caseId: "$caseId",
      damageShownToCustomer: false,
      writtenScopeProvided: false,
      decisionRequestedBy: "TODAY",
    },
  },
  {
    said: "Get me another opinion.",
    tool: "structure_scope",
    arguments: { caseId: "$caseId" },
    note: "The request says where to look and not what to conclude. What it leaves out is shown.",
  },
  {
    tool: "find_independent_professionals",
    arguments: { caseId: "$caseId", limit: 3 },
    note: "Ordered by how little the assessor gains from the answer, not by rating.",
  },
  {
    said: "Send it to the first one.",
    tool: "request_second_opinion",
    arguments: { caseId: "$caseId", providerId: "$providerId" },
  },
  {
    caption: "Next morning",
    said: "The assessment came back.",
    tool: "add_quote",
    arguments: {
      caseId: "$caseId",
      contractorName: "Nine Elms Exterior Surveys",
      source: "SECOND_OPINION",
      text: INDEPENDENT_QUOTE,
    },
  },
  {
    said: "Compare the two quotes.",
    tool: "compare_quotes",
    arguments: { caseId: "$caseId" },
    note: "THE REFUSAL. One is a single number for a paragraph of work, so the gap cannot be split up. CIRCA says what would make it answerable.",
  },
  {
    caption: "That afternoon, after the customer asked for it itemised",
    said: "They sent it again, broken down.",
    tool: "add_quote",
    arguments: {
      caseId: "$caseId",
      contractorName: "Apex Exteriors",
      source: "CONTRACTOR",
      text: ITEMISED_REQUOTE,
    },
  },
  {
    said: "Compare them again.",
    tool: "compare_quotes",
    arguments: { caseId: "$caseId", quoteAId: "$quoteApex", quoteBId: "$quoteB" },
    note: "THE PAYOFF. The same call now decomposes the difference. The product's advice changed what the product could compute.",
  },
  {
    said: "I will go with the second one.",
    tool: "accept_scope",
    arguments: { caseId: "$caseId", quoteId: "$quoteB" },
    note: "The baseline is written once and never rewritten.",
  },
  {
    caption: "Three weeks later, during the repair",
    said: "They want another two thousand two hundred for decking. Is that in what I agreed to?",
    tool: "record_scope_change",
    arguments: {
      caseId: "$caseId",
      describedAs: "They say the decking underneath is rotten and needs replacing, another two thousand two hundred",
      amount: 2200,
    },
    note: "Measured against what was accepted three weeks ago, not against what anyone remembers.",
  },
  {
    said: "Ask them to put it in writing.",
    tool: "set_change_status",
    arguments: { caseId: "$caseId", changeId: "$changeId", status: "DOCUMENTED" },
  },
  {
    said: "Show me the whole thing.",
    tool: "get_repair_dossier",
    arguments: { caseId: "$caseId" },
  },
];
