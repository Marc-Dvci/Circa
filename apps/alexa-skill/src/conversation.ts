/**
 * The demonstrated conversation on today's Alexa.
 *
 * One list, read twice. `tests/alexa-skill.test.ts` sends each turn to the skill
 * as the IntentRequest it names, with the slots it names, against a memory
 * store. `tools/alexa/src/simulate.ts` types each `said` into Amazon's Skill
 * Simulation API against the deployed skill, and checks that Alexa's own
 * interaction model resolved it to the same intent. The test proves the host;
 * the simulation proves that Alexa reaches it with what the test assumed.
 *
 * The arc is the demo's: the refusal, the itemised re-quote, the payoff, then a
 * new session three weeks later that finds the record without being told.
 */

export interface ConversationTurn {
  said: string;
  /** Start a new Alexa session before this turn. */
  newSession?: boolean;
  /** What the local test sends, and what the simulation expects Alexa to resolve. */
  request: "LaunchRequest" | { intent: string; slots?: Record<string, { value: string; id?: string }> };
  /** Fragments the spoken answer must contain. */
  expect?: string[];
  note?: string;
}

export const INVOCATION = "circa quote check";

export const CONVERSATION: readonly ConversationTurn[] = [
  { said: `open ${INVOCATION}`, newSession: true, request: "LaunchRequest" },
  {
    said: "a roofer knocked on the door and says the flashing round the chimney has failed",
    request: { intent: "DoorKnockIntent", slots: { issue: { value: "the flashing round the chimney has failed" } } },
    expect: ["opened a record"],
  },
  {
    said: "they want six thousand five hundred, three thousand of it today, and they say water could get in tonight",
    request: {
      intent: "OfferIntent",
      slots: { offer: { value: "six thousand five hundred three thousand of it today and they say water could get in tonight" } },
    },
    expect: ["unsolicited approach and deposit size"],
    note: "The amounts are read by the deterministic planner, from the words.",
  },
  {
    said: "no, I have not seen it, and there is nothing in writing",
    request: {
      intent: "AnswerIntent",
      slots: { shown: { value: "i have not seen it", id: "NOT_SHOWN" }, written: { value: "nothing in writing", id: "NOT_WRITTEN" } },
    },
  },
  { said: "get me another opinion", request: { intent: "SecondOpinionIntent" }, expect: ["not what to conclude"] },
  { said: "send it to the first one", request: { intent: "SendRequestIntent" }, expect: ["Sent to"] },
  { said: "the assessment came back", request: { intent: "AssessmentBackIntent" }, expect: ["Added Nine Elms Exterior Surveys at $1,850"] },
  {
    said: "compare the two quotes",
    request: { intent: "CompareIntent" },
    expect: ["The first quote is $6,500", "$4,650", "I cannot set these side by side"],
    note: "THE REFUSAL.",
  },
  { said: "they sent it again, broken down", request: { intent: "RequoteIntent" }, expect: ["itemised across 5 lines"] },
  {
    said: "compare them again",
    request: { intent: "CompareIntent" },
    expect: ["$4,030", "$420", "$200", "Seal penetrations"],
    note: "THE PAYOFF.",
  },
  {
    said: "I will go with the second one",
    request: { intent: "AcceptIntent", slots: { which: { value: "second", id: "SECOND" } } },
    expect: ["You accepted $1,850"],
  },
  {
    said: `open ${INVOCATION}`,
    newSession: true,
    request: "LaunchRequest",
    expect: ["1 repair"],
    note: "A new session: the record is read back from DynamoDB, not from the session.",
  },
  { said: "where do we stand", request: { intent: "StatusIntent" } },
  {
    said: "they want another two thousand two hundred for decking",
    request: { intent: "ScopeChangeIntent", slots: { change: { value: "two thousand two hundred for decking" } } },
    expect: ["Roof decking is not in the scope you accepted"],
  },
  { said: "ask them to put it in writing", request: { intent: "PutInWritingIntent" }, expect: ["Noted as documented"] },
  { said: "show me the whole thing", request: { intent: "DossierIntent" }, expect: ["You accepted $1,850"] },
  { said: "delete this repair", request: { intent: "DeleteRepairIntent" }, expect: ["Shall I delete it?"] },
  { said: "yes", request: { intent: "AMAZON.YesIntent" }, expect: ["Deleted."] },
];
