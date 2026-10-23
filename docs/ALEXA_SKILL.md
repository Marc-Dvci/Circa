# Today's Alexa: the classic custom skill

CIRCA's MCP server also answers on today's Alexa, through a classic custom
skill. The skill is a host, like the Alexa+ simulator: Alexa's interaction
model resolves a sentence to an intent, and an AWS Lambda turns the intent into
calls on the same sixteen MCP tools, through the MCP SDK's own `Client`. Every
sentence about the repair is the tool result's own `content`, so the skill and
the add-on cannot disagree about what a result says.

| | |
|---|---|
| skill package | [`apps/alexa-skill/skill-package/`](../apps/alexa-skill/skill-package): `skill.json` and the en-US interaction model, invocation name **circa quote check** |
| the host | [`apps/alexa-skill/src/skill.ts`](../apps/alexa-skill/src/skill.ts): one method per intent, no product logic |
| the Lambda | [`apps/alexa-skill/src/lambda.ts`](../apps/alexa-skill/src/lambda.ts): builds the `McpServer`, connects the SDK `Client` over an in-memory transport, answers the envelope |
| deployed | `circa-alexa-skill`, AWS Lambda in us-east-1, Node.js 22 on arm64, with the DynamoDB table `circa-alexa` (`pnpm alexa:deploy`) |
| the conversation | [`apps/alexa-skill/src/conversation.ts`](../apps/alexa-skill/src/conversation.ts): 18 turns, the demo's arc plus a second session |
| a run against the deployed Lambda | [`docs/alexa/RUN.md`](alexa/RUN.md), every envelope in [`run.json`](alexa/run.json) |

## One intent, one tool

On Alexa+ a model reads the tool schemas and decides what to call. Here Alexa's
interaction model decides, so each intent names the tool it maps to:

| intent | sample | MCP tool |
|---|---|---|
| `CheckRepairIntent`, `DoorKnockIntent` | "a roofer knocked on the door and says {issue}" | `start_repair_case` |
| `OfferIntent` | "they want {offer}" | `capture_offer`, or `record_scope_change` once a scope is accepted |
| `AnswerIntent` | "no {shown} and there is {written}" | `answer_verification_question` |
| `StatusIntent` | "where do we stand" | `get_verification_status` |
| `SecondOpinionIntent` | "get me another opinion" | `structure_scope`, `find_independent_professionals` |
| `SendRequestIntent` | "send it to the first one" | `request_second_opinion` |
| `AssessmentBackIntent`, `RequoteIntent` | "the assessment came back" | `add_quote` |
| `CompareIntent` | "compare the two quotes" | `compare_quotes` |
| `AcceptIntent` | "I will go with the {which} one" | `accept_scope` |
| `ScopeChangeIntent` | "they want another {change}" | `record_scope_change` |
| `PutInWritingIntent` | "ask them to put it in writing" | `set_change_status` |
| `DossierIntent` | "show me the whole thing" | `get_repair_dossier` |
| `ListRepairsIntent` | "what repairs do I have" | `list_repair_cases` |
| `DeleteRepairIntent`, then `AMAZON.YesIntent` | "delete this repair", "yes" | `delete_repair_case`, only after the yes |

Free speech arrives in `AMAZON.SearchQuery` slots. Alexa does not allow a
SearchQuery slot beside another slot in one sample, so "six thousand five
hundred, three thousand of it today" arrives as words, and the amounts are read
from them by the deterministic planner (`apps/agent/src/planner.ts`), the same
code the simulator and `pnpm circa say` use. The customer's answers about the
damage and the paperwork are custom slot types with entity-resolution ids, so
"I haven't seen it" and "they didn't show me" both resolve to `NOT_SHOWN`.

"They want ..." is an offer before a scope is accepted and a change order
after it. The interaction model cannot know which; the record can, so the record
decides.

## The record, not the session

Nothing about the repair travels in Alexa's session attributes. Every turn
reads the case back with `list_repair_cases` and `get_repair_dossier`, so a
conversation that ends and starts again weeks later continues from what was
recorded. The session keeps only what no tool returns twice: the assessor last
offered, the change last recorded, and the customer's own words from earlier
turns. Alexa's user id is stored as a SHA-256 digest, never as itself.

In the run against the deployed Lambda, turn 12 is a new session. The skill had
no session attributes and found the repair in DynamoDB:

> This is CIRCA. 1 repair: The flashing round the chimney, decision recorded.
> Tell me what has happened since, or ask where we stand.

## Documents

A voice turn cannot carry a document. In the product a quote arrives as a photo
or PDF the customer uploads (`add_quote` with a `documentKey`, read from S3).
In this conversation the two documents are the demo script's own fixtures, the
same text `pnpm demo` and the simulator send to `add_quote`.

## What it found

Driving the engine from a voice transcript, rather than from the demo script,
found three defects the corpora did not, because the script always names the
contractor and always sends commas:

- **Spoken amounts without punctuation.** "six thousand five hundred three
  thousand of it today" read as one number, 509,000. A second "thousand" now
  starts a second amount and takes the words since the last "hundred" with it:
  6,500, and a 3,000 deposit. "three thousand of it today" is now read as a
  deposit, and "they say water could get in tonight" is kept as the urgency
  claim rather than the first time word in the sentence.
- **An unnamed contractor started a sentence in lower case**: "the first quote
  is $6,500." A contractor at the door rarely gives a company name, so this is
  the normal case on voice.
- **A quoted case was titled "not yet quoted"** when the quote had a price and
  no company name.

## Run it

```bash
pnpm alexa:run                       # the 18 turns through Virtual Alexa, in-process, memory store
pnpm alexa:build                     # the Lambda bundle, dist/alexa-skill/
AWS_PROFILE=<profile> pnpm alexa:deploy             # the table, the role and the function
AWS_PROFILE=<profile> pnpm alexa:run --lambda --write   # the same turns against the deployed function
```

`pnpm alexa:run` uses Bespoken's [Virtual Alexa](https://github.com/bespoken/virtual-alexa)
(`virtual-alexa` 0.7.8), a client this repository did not write: it reads the
interaction model, resolves each sentence to an intent and its slots, and builds
the request envelope with the session attributes the skill returned. It
checks, per turn, that the sentence resolved to the intent the conversation
names and that the answer says what it should. `tests/alexa-skill.test.ts`
runs it on every push, alongside tests that hold the interaction model to
Alexa's rules: a two-word invocation name with no launch or connecting words,
every sample in exactly one intent, no SearchQuery slot beside another slot.

With `CIRCA_SKILL_ID` set, `pnpm alexa:deploy` grants that skill, and only that
skill, permission to invoke the function (the event source token is the skill
id), and the handler checks the application id on every request.
