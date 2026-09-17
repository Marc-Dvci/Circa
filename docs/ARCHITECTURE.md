# Architecture

Six layers. What makes this worth reading is not what each layer does but what
each is forbidden to do, because every constraint below was chosen to make one
specific failure impossible rather than unlikely.

```
        voice / screen                         a terminal
              │                                     │
    ┌─────────┴──────────┐                          │
    │  Alexa+ simulator  │   Streamable HTTP        │
    │  host, SEP-1865    │──────────┐               │
    └────────────────────┘          │               │
                                    ▼               ▼
                        ┌───────────────────┐   ┌────────┐
                        │  MCP server       │   │  CLI   │
                        │  16 tools 6 views │   │        │
                        └─────────┬─────────┘   └───┬────┘
                                  │                 │
                        ┌─────────▼─────────────────▼─────┐
                        │  present()                      │
                        │  speech · rows · actions        │
                        └─────────────┬───────────────────┘
                                      │
    ┌─────────────────────────────────▼──────────────────────────────────┐
    │  CaseService, event-sourced        memory · file · DynamoDB        │
    ├────────────────────────────────────────────────────────────────────┤
    │  verification (18 rules)   normalizer   taxonomy   documents       │
    ├────────────────────────────────────────────────────────────────────┤
    │  repair-schema      integer cents, work units, zod v4              │
    └────────────────────────────────────────────────────────────────────┘
```

---

## `packages/repair-schema` — the wire format

No I/O, no model, no network, no dependency on any other package here. It is the
open-source extraction candidate and it is written as though it already had been.

Money is integer cents everywhere inside the system. Dollars exist only at the
MCP boundary, where they exist because a model that has just heard "six thousand
five hundred" will emit `6500`, and a schema demanding cents would be violated by
a factor of a hundred while validating cleanly.

`assertSafeLanguage` lives here rather than in the presentation layer, because
the sentences it guards are constructed in the rules and a check applied at the
edge is a check applied after the mistake.

## `packages/taxonomy` — what the trades call things

103 components across 5 trades, 777 lexical forms, subsumption
(`roof.full_replacement` contains its parts), an action lexicon, and an
enumerated ambiguity set.

**A component is assigned only when one of its lexemes appears literally in the
text.** There is no similarity measure, no embedding, no threshold to tune. This
is the constraint the model paths are checked against: a model may propose, it
may not invent.

Two lexicons, not one. A bare system name like "roof" fires only when the clause
named no component at all, because a verb-phrase lexeme wins the longest-match
contest against a specific noun and `Replace roof decking, 6 sheets .... $4,030`
would otherwise assert a whole-roof replacement with the decking's money attached
to it.

Ten phrases are claimed by two components and are enumerated rather than
resolved. Where the trade settles them the normaliser uses the trade; where it
cannot, the phrase maps to nothing and the comparison reports unmapped work.

## `packages/normalizer` — text to work units

`normaliseLineItem` (negation, quantity, trade disambiguation, nearest preceding
verb), `parseQuoteText`, `quoteFromSpokenOffer`, `compareQuotes`,
`explainComparison`, and `buildNeutralScope` with `findAnchoring`.

**The neutral scope withholds the first opinion, and the withholding is checked
rather than trusted.** A second opinion is not independent if the request carries
the first one's diagnosis, price or the contractor's name. `findAnchoring` reads
the generated text back against the case and reports what leaked. It has already
caught one real leak: an action verb was reaching across a whole document, so a
requirements list whose last line said "replacement" turned "materials" six
sentences earlier into a proposed replacement.

## `packages/verification` — the rules

18 rules across IDENTITY, PROPOSAL, DECISION_CONDITIONS and INDEPENDENT_EVIDENCE.
Each returns `CLEAR`, `VERIFY`, `ATTENTION` or `NOT_APPLICABLE`, each cites its
basis, and 16 of the 18 cite published FTC or AARP guidance by URL.

A rule reads `CaseFacts` and nothing else. `CaseFacts` is the whitelist of
everything a rule may see, which is what stops a rule from reaching into the
store, calling a service or reading a field somebody added for another purpose.

## `packages/documents` — the isolation boundary

Document text enters the system through `isolate()` and through nothing else. The
field is called `untrustedText` so that a reviewer sees the mistake in a diff.

`renderForModel()` wraps it in a nonce-delimited envelope with the rules stated
before it. `scanForInjection()` is 22 detectors across 7 categories and is a
label for the user rather than a defence. `groundProposal()` is the check that
does the work: every proposed line must appear in the document, every amount must
appear in the document, and the work units are re-derived by `normaliseLineItem`
rather than taken from the model. See `docs/THREAT_MODEL.md`.

## `packages/store` — the record

`CaseService` is every operation the product can perform, event-sourced onto a
timeline, over a `CaseRepository` with three implementations: memory, file with
atomic rename, and DynamoDB with optimistic concurrency.

`packages/store/src/dynamo-double.ts` is a table double that *enforces* the two
condition expressions the adapter sends and throws on anything it does not
understand. A double that accepted every write would let optimistic concurrency
ship inverted with a green suite, so `tests/smoke.test.ts` drives it into the
conflict branch on purpose.

The baseline is written once and never rewritten. `acceptScope` on a case that
already has one throws, because a baseline that can be replaced is a note rather
than a record of an agreement.

---

## `apps/agent/src/present.ts` — one place that decides what a result says

Three surfaces read a case, and a fourth, voice, is the one that matters. If each
rendered the engine's output for itself they would drift, and the drift would be
invisible: a screen showing four open items beside a voice line saying three is
not a layout bug, it is two opinions about the same repair.

So the payload is built once here, complete with the sentence to speak and the
rows to draw, and the views are dumb. Everything a view shows, `speech` has
already said. That is what makes voice-only a first-class path rather than a
degraded one, and it is the reason the simulator can be trusted as evidence: if a
card shows something the transcript does not say, the payload was wrong.

## `apps/mcp-server` — the tool surface

Sixteen tools that hold no product logic. No threshold, no wording decision, no
arithmetic on money beyond the boundary conversion. The claim is kept true by
`pnpm circa`, which reaches the same service and prints the same payloads, so a
rule that migrated into a handler would be a rule the CLI does not have.

The six MCP Apps views declare `csp.connectDomains: []` and load nothing, which
is asserted against the served HTML rather than against the declaration alone.

## `apps/agent/src/planner.ts` — the deterministic planner

Ten patterns, spoken-number parsing, and a clarification rather than a guess when
the shape matched but the state cannot support it.

It exists for two reasons and the second is the important one. The first is that
a judge on a clean clone with no AWS account must be able to run the whole demo.
The second is that it is the measurement baseline: when the Bedrock path is
switched on, the corpus is scored against both, and a model that cannot beat a
regex on the demo scenarios has not earned its latency. Keeping the deterministic
path when the model arrives is what makes that comparison possible.

A builder returns `undefined` when the shape matched but the state cannot support
it, and that is not a fall-through to a different tool. "Compare the quotes" with
one quote on file produces a clarification, because doing something adjacent to
what was asked is how an agent loses a person's trust in one turn.

## Where a model is used

Two places, both optional, both off by default, both checked afterwards.

**Reading a photographed document.** A two-column layout with a handwritten total
defeats a parser. A model proposes a structure; `groundProposal` then discards
every line and every amount the document does not contain, and re-derives the
work units with the same function the deterministic path uses.

**Saying it out loud.** The deterministic sentences are correct and stiff. A model
rephrases them, and `checkVoice` rejects the result if it contains a monetary
amount or a percentage the payload does not contain, or if it trips
`assertSafeLanguage`. On rejection the deterministic sentence is spoken. There is
no third option and no repair loop.

A model that went missing would change nothing about what CIRCA concludes.

## `apps/simulator` — the host

React over Vite. It connects to the MCP server with the SDK's own
`StreamableHTTPClientTransport` and implements the host half of SEP-1865: the
three host-to-view notifications, and the four view-to-host requests and
notifications. The view runs in an iframe with `sandbox="allow-scripts"`, so the
page cannot read into it and it cannot read out.

The dev server starts the MCP server as a separate process on its own port and
proxies `/mcp` to it. Running it in-process would have been fewer moving parts
and would also have made the transport a fiction, because a client that shares a
module graph with its server is not exercising a transport.

`tests/simulator.test.ts` mounts the page with React's own client renderer
against a real server and presses the buttons. A suite that only tests the API
can be entirely green while the page a judge watches is blank.
