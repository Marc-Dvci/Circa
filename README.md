# CIRCA

**CIRCA is an Alexa+ add-on that keeps the record of a home repair you are
deciding about, and checks what can be checked before money moves.** You tell it
what a contractor has offered. It returns a checklist of what is established and
what is not, writes an independent assessment request that withholds the first
contractor's diagnosis, compares two quotes when there are two, and holds the
scope you accepted so that a request for more money three weeks later can be
measured against it.

It is a self-hosted MCP server, protocol **2025-11-25** over Streamable HTTP,
with six MCP Apps views for screen devices and a spoken answer that is complete
without any of them.

```
You      Compare the two quotes.

CIRCA    Apex Exteriors is $6,500. Nine Elms Exterior Surveys is $1,850. That is
         a difference of $4,650. I cannot set these side by side, because one of
         these is a single price for everything it describes, so there is no way
         to tell which part of the money belongs to which piece of work. That is
         a property of the document, not of the roof.

         Ask for the same quote itemised, with a price against each line. Then
         the same comparison can answer it.
```

That refusal is the product. A price difference is not a finding until the scopes
are aligned, and it is not attributable at all unless both documents put their
money against the work they describe. Most residential quotes are a single number
for a paragraph of work, so `compare_quotes` returns `identifiable: false` with a
named reason more often than it returns a decomposition. Of the 14 labelled quote
pairs in the corpus, 6 cannot be attributed, and the engine gets all 6 right.

Later in the same conversation, after the customer asks for the itemised version
and the contractor sends it, the same call returns:

```
CIRCA    Of the $4,650 difference, $4,030 is work only Apex Exteriors is
         proposing, $420 is the same work at a different price, and $200 is
         not accounted for by either. All of that $200 sits on one line I
         could not classify: "Seal penetrations". That is the line to ask
         about.
```

The product's advice changed what the product could compute.

---

## Run it

```bash
git clone https://github.com/Marc-Dvci/Circa
cd Circa
pnpm install

pnpm demo          # the whole three-minute arc, 14 real MCP tool calls, ~50 ms
pnpm simulator:dev # the Alexa+ simulator, at http://localhost:5173
```

No AWS account, no credentials, no API keys. `pnpm simulator:dev` starts the MCP
server as a separate process and opens a host that connects to it with the MCP
SDK's own Streamable HTTP client. The status bar prints the protocol version the
two sides negotiated, so it can be read rather than taken on trust.

Everything else:

```bash
pnpm verify        # typecheck, 107 tests, three evaluation corpora
pnpm eval          # the corpora on their own, with the metrics below
pnpm bench         # latency per tool against the 500 ms Alexa+ budget
pnpm check         # what is actually live here: store, credentials, optional paths
pnpm mcp           # just the server, on :8787
pnpm circa help    # the same repair record from a terminal
pnpm demo --tour   # the demo, slowed down, with the reasoning printed
pnpm cdk:synth     # the CloudFormation this would deploy to
pnpm check:citations  # fetch every URL the rules cite and expect 200
```

---

## What it does

**Records an offer and runs a checklist.** Eighteen deterministic rules across
four dimensions. Sixteen of them cite published FTC or AARP consumer guidance by
URL; the two that do not are labelled `CIRCA_POLICY` in the product, because the
difference between "the FTC recommends comparing written estimates" and "we think
you should" is what makes a checklist actionable. Each returns one of four statuses: `CLEAR`, `VERIFY`, `ATTENTION`, or
`NOT_APPLICABLE`. A rule that does not apply is reported as such rather than
omitted, so a checklist that shrinks cannot be mistaken for one that passed.

**Writes the second-opinion request itself.** The request says where to look and
not what to conclude. The first contractor's price, company name and urgency
claim are removed, and the list of what was withheld is shown to the customer
with the reason. `findAnchoring` checks the generated text against the case
rather than trusting the generator, and it has already caught one leak.

**Aligns two quotes before it compares them.** Work units are extracted from the
text of each document against a taxonomy of 103 components and 777 lexical forms,
with subsumption, so "full roof replacement" is understood to contain the eight
shingles the other quote prices. Then it either attributes the difference or says
why it cannot.

**Holds what was accepted.** The baseline is written once and never rewritten.
When a change is proposed, it is measured against that record rather than against
anyone's memory, and the review reports which parts are new work and which were
already agreed.

## What it refuses to do

There is no score. Not a risk percentage, not a trust rating, not a
five-of-nine-checks-complete number dressed up as one. Aggregating a checklist
into a single figure invents a comparison between items that are not comparable.

`undefined` is not `false`. "Not told" and "no" are different facts, and only a
positively recorded condition can raise `ATTENTION`. That distinction is the
whole of the false-alarm control, and it is why 24 ordinary repairs in the
scenario corpus produce zero findings.

It will not tell you whether a contractor is trustworthy. It says so in that
sentence and then gives the checklist. Thirteen forbidden language patterns are
enforced in code by `assertSafeLanguage`, which throws rather than warns, and
every rule statement and spoken sentence passes through it.

---

## Measured

Every number below comes from a command in this repository.

| | | how |
|---|---|---|
| tests | 107 | `pnpm test` |
| typecheck | clean | `pnpm typecheck` |
| protocol negotiated | **2025-11-25** | `tests/mcp-conformance.test.ts`, a real SDK client on a real socket |
| MCP tools | 16 | `pnpm eval`, `/health` |
| MCP Apps views | 6 | `/health` |
| scenario corpus | 48 repairs, 24 of them ordinary | `pnpm eval --scenarios` |
| **false alarms on ordinary repairs** | **0.0%** (0 of 24) | " |
| ATTENTION precision / recall | 100% / 100% | " |
| quote pairs | 14, of which 6 cannot be attributed | `pnpm eval --quotes` |
| **correct refusals** | **100% recall, 100% precision** | " |
| verdict / alignment accuracy | 100% / 100% | " |
| injection corpus | 16 attacks, 8 controls | `pnpm eval --injection` |
| **containment failures** | **0** | " |
| detection recall / control false positives | 100% / 0 | " |
| taxonomy | 103 components, 777 lexical forms | `pnpm eval --lexicon` |
| verification rules | 18, across 4 dimensions, 16 citing published guidance | " |
| injection detectors | 22, across 7 categories | " |
| slowest tool at p95 | **6.2 ms** against a 500 ms budget | `pnpm bench`, 360 calls over the wire |
| demo | 14 tool calls, 48 ms total | `pnpm demo` |

The three corpora found seven defects in the engine that 38 passing unit tests
did not. `docs/EVAL.md` names each one.

---

## How it is put together

```
        voice / screen                    a terminal
              │                                │
    ┌─────────┴──────────┐                     │
    │  Alexa+ simulator  │  Streamable HTTP    │
    │  (host, SEP-1865)  │──────┐              │
    └────────────────────┘      │              │
                                ▼              ▼
                    ┌───────────────────┐  ┌────────┐
                    │  MCP server       │  │  CLI   │
                    │  16 tools, 6 views│  │        │
                    └─────────┬─────────┘  └───┬────┘
                              │                │
                    ┌─────────▼────────────────▼─────┐
                    │  present()  one place that     │
                    │  decides what a result says    │
                    └─────────────┬──────────────────┘
                                  │
    ┌─────────────────────────────▼──────────────────────────────┐
    │  engine: schema · taxonomy · normaliser · comparison ·      │
    │  verification · case service · memory / file / DynamoDB     │
    └─────────────────────────────────────────────────────────────┘
```

Three surfaces read a case, and a fourth, voice, is the one that matters. If each
rendered the engine's output for itself they would drift, and the drift would be
invisible: a screen showing four open items beside a voice line saying three is
not a layout bug. So `apps/agent/src/present.ts` builds the payload once,
complete with the sentence to speak and the rows to draw, and the views are dumb.
Everything a view shows, `speech` has already said.

The MCP tools hold no product logic. That claim is kept true by having a second
caller that would notice if it stopped being true: `pnpm circa` reaches the same
`CaseService` and prints the same `present()` payloads.

| path | what it is |
|---|---|
| `packages/repair-schema` | The wire format. Money in integer cents, work units, comparison results, verification vocabulary. No I/O, no model, no network. |
| `packages/taxonomy` | 103 components across 5 trades, 777 lexical forms, subsumption, an action lexicon, and an enumerated ambiguity set the normaliser refuses to guess through. |
| `packages/normalizer` | Text to work units, quote parsing, `compareQuotes`, and the neutral scope with its anchoring check. |
| `packages/verification` | 18 rules, each citing its basis, plus the change-order review. |
| `packages/documents` | The isolation boundary. Document text enters through `isolate()` and reaches a model only inside a nonce-delimited envelope. `groundProposal` refuses the parts of a model's output that are not in the document. |
| `packages/providers` | 30 fictional assessors, ranked lexicographically by independence, then availability, then rating. |
| `packages/store` | `CaseService` over memory, file and DynamoDB repositories, event-sourced onto a timeline. |
| `apps/mcp-server` | The server, the 16 tools, the 6 views, Streamable HTTP, and OAuth 2.1 with PKCE. |
| `apps/agent` | `present()`, the deterministic planner, the voice check, and the Bedrock paths. |
| `apps/simulator` | The Alexa+ host: React, the SEP-1865 host half, an Echo Show card and the transcript side by side. |
| `infrastructure/cdk` | The stack this would deploy to. Synthesised, never applied. |

---

## Documentation

| | |
|---|---|
| [`docs/MODEL.md`](docs/MODEL.md) | Every threshold in the product and the reason for it |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | The layers, and what each is not allowed to do |
| [`docs/MCP.md`](docs/MCP.md) | The 16 tools, the 6 views, and the SEP-1865 wire |
| [`docs/EVAL.md`](docs/EVAL.md) | The three corpora, the metrics, and the seven defects they found |
| [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) | Prompt injection through a contractor's document, and what stops it |
| [`docs/AUTH.md`](docs/AUTH.md) | Account linking: OAuth 2.1, PKCE S256, and one deliberate RFC deviation |
| [`docs/PRIVACY.md`](docs/PRIVACY.md) | What is stored, for how long, and how to delete it |
| [`docs/AWS.md`](docs/AWS.md) | Bedrock, Textract, DynamoDB, S3, CDK, and why nothing is deployed |
| [`docs/DEMO_SCRIPT.md`](docs/DEMO_SCRIPT.md) | The video, beat by beat, generated from the script the demo runs |
| [`docs/FRICTION_LOG.md`](docs/FRICTION_LOG.md) | Eight entries against Alexa+, MCP, MCP Apps, the Alexa+ toolkit and AWS |
| [`docs/PRODUCT_FEEDBACK.md`](docs/PRODUCT_FEEDBACK.md) | Every tool, API and SDK used, and whether I would build with it again |
| [`docs/JUDGE.md`](docs/JUDGE.md) | Five minutes, in order |
| [`docs/TERMS.md`](docs/TERMS.md) | Terms of use, referenced by the add-on manifest |

---

## Licence and provenance

Apache-2.0. See [`LICENSE`](LICENSE).

Everything in this repository was written during the Amazon Developer Hackathon
submission window. The tracks entered are **Alexa+** as the primary track, plus
the **AWS Builder** and **Open Source** mini challenges.
