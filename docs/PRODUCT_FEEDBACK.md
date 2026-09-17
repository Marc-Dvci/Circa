# Product feedback

Every tool, API and SDK this project uses, what it was used for, what worked,
what needs work, how onboarding felt, and whether I would build with it again.

---

## Alexa+ MCP add-ons

**Used for:** the whole product. CIRCA is a self-hosted MCP server exposing
sixteen tools and six MCP Apps views, plus an account-linking flow and a
submission manifest.

**What worked well.** The requirements are specific enough to build against
without guessing: Streamable HTTP, protocol 2025-11-25 or later, a round-trip
budget of under 500 ms, and a manifest whose field limits are all stated. Being
given a hard latency number is unusually good. It turned into a command
(`pnpm bench`) that reports p50 and p95 per tool against 500 ms, which is a
better artefact than the impression I would otherwise have shipped.

The tool-schema guidance is the best part of the documentation. "The model treats
the schema as a promise" changed how I wrote the tool surface: there is no field
in `apps/mcp-server/src/tools.ts` the service ignores, and where the product
cannot do something there is no parameter for it. That one sentence is worth more
than a page of examples.

Requiring static client registration and no DCR, no OIDC and no step-up made the
authorization server small enough to write out and read in one sitting, which
made it small enough to test exhaustively.

**What needs work.**

- The 401 shape and RFC 9728 §5.1 disagree, and the page does not say which
  wins. Friction log entry 1.
- The `resource` parameter is required on the authorization and token-exchange
  requests but not on refresh, and the exception is a trailing clause inside a
  parameter table. The bug it causes appears exactly one token lifetime after
  everything looked fine. Friction log entry 2.
- I could not find a statement of what the 500 ms budget includes. Is it the
  add-on's own round trip, or does it include the model turn that decided to call
  the tool? The measurement I built assumes the former, and says so, but a server
  author sizing a database call would like to know which.
- There is no way to exercise a tool surface against Alexa+ itself without
  publishing. A conformance target, even a strict offline validator for the
  manifest and the tool schemas, would remove a whole class of submission-day
  surprises. I ended up writing my own for the manifest
  (`tests/addon.test.ts`), which checks the documented character limits so that a
  description that grew past 123 characters fails a test rather than a
  submission.

**Onboarding.** Good. From the requirements page to a server negotiating
2025-11-25 with the SDK's own client took under an hour, and most of that was
choosing a transport shape rather than fighting anything.

**Would I build with it again.** Yes. The constraint that produced the best part
of this project came from the platform: a voice-first surface where the screen is
optional forces you to make the spoken answer complete, and that pushed the
entire product into one place that decides what a result says.

---

## The Alexa+ MCP Toolkit: the CLI, the Local Inspector and the Web Simulator

**Not used, and the reason is the first thing worth reporting.**

The [MCP QuickStart Guide](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-quickstart.html)
opens with "**Step 1. Download and install CLI and authenticate**", and that
heading is the whole of the install instructions. There is no download link, no
package name, no `npm i -g`, no `brew install`, no installer, and no link
anywhere else on the page. The next line is `alexa-ai configure`, which is what
you run *after* the step the page does not describe.

The obvious guess is worse than no guess: `alexa-ai` on the public npm registry
is an unrelated third-party package — a WhatsApp chatbot at version 2.5.0,
published by someone with no connection to Amazon. A developer following the
quickstart, hitting a missing step, and doing the natural thing installs a
stranger's package globally. That is a supply-chain hazard created by a missing
sentence, and it is the single highest-value fix on this page.

So the toolkit is absent from this project, and everything it would have done was
done by hand instead:

| toolkit | what CIRCA did instead |
|---|---|
| `alexa-ai new mcp` scaffolds `addon-package/addon.json` | `addon-package/addon.json` written against the schema reference on the quickstart page, with `tests/addon.test.ts` asserting the nesting, the six icon sizes, the 600x900 carousel image and every documented character limit |
| Local Inspector | `tests/mcp-conformance.test.ts` drives the SDK's own client over Streamable HTTP on a real socket, and `tests/mcp-apps.test.ts` runs the view and the host against each other in a DOM |
| Web Simulator | `apps/simulator`, a host rather than a mock: it holds no product knowledge and draws only what arrives in a tool result |

**What I can say about the manifest without the CLI.** The schema reference is
good: it gives the nesting, every character limit, the required icon sizes and
the endpoint `type`. Writing to it by hand took twenty minutes and produced a
document a test can check. Two things would have saved time. The field
constraints table lists `mediaAssets.icons.light` as "All 6 sizes required:
72x72, 64x64, 88x88, 126x126, 180x180, 241x241" — an order that is neither
ascending nor a dimension anyone would guess, so it has to be copied exactly and
there is no schema file to copy it from. And nothing states whether the media
URIs must already resolve at submission time or whether they are fetched at
certification, which decides whether a repository can host them.

**What I would want most, after an install link.** A published JSON Schema for
`addon.json`, and `alexa-ai validate` as a command that runs without
authenticating. Both of those are things a project can put in CI; `deploy` and
`submit` are not, and a toolkit whose only offline verb is `new` leaves a
manifest unchecked until the first upload.

---

## Model Context Protocol, spec 2025-11-25

**Used for:** the transport, tool registration, resources, capability
negotiation.

**What worked well.** Streamable HTTP with a session id is the right shape for a
conversation that spans a fortnight. Stateful sessions with a server-to-client
stream mean the server can say something without being asked, which a
long-running case genuinely needs.

Structured output alongside text content is the feature that made voice-only real
here. The same call returns a sentence a speaker can read and a payload a screen
can draw, so the two cannot disagree.

**What needs work.** The specification is clear about the wire and quiet about
operational shape. Two questions I had to answer by choosing: how long a session
should live, and whether a server should expect a client to reconnect to the same
session after a network drop. Neither is a protocol question exactly, and both
determine whether the server is right.

**Would I build with it again.** Yes.

---

## `@modelcontextprotocol/sdk` 1.30.0 (TypeScript)

**Used for:** `McpServer`, `StreamableHTTPServerTransport`, `Client`,
`StreamableHTTPClientTransport`.

**What worked well.** `ServerCapabilities` has a native `extensions` record, so
declaring `io.modelcontextprotocol/ui` needed no escape hatch. `registerTool`
with a zod schema and an `outputSchema` is a pleasant API and the generated JSON
Schema is what the tests assert against.

The client transport bundles for the browser without a shim, which is what makes
the simulator in this repository a real host rather than a mock: the page runs the
SDK's own client against the SDK's own server over a socket. That is not stated
anywhere I could find, and it is worth stating, because it is the difference
between a demo that proves something and a demo that draws a picture of it.

Being able to connect a real client to a real server in a test is the single most
valuable thing the SDK provides. Every conformance claim in this project is made
by `tests/mcp-conformance.test.ts` reading `transport.protocolVersion` after a
genuine `initialize`, rather than by a constant this repository chose.

**What needs work.**

- The browser story is undocumented. Bundle size for the client is around
  470 kB minified, most of it schema validation, and there is no browser-oriented
  entry point that drops the server half.
- `LATEST_PROTOCOL_VERSION` is exported, which is useful, but there is no
  exported list of what a given SDK version can negotiate down to. `/health` in
  this project reports the SDK's latest and the version Alexa+ requires as two
  separate fields, so that it is red on the day those diverge rather than green.

**Onboarding.** Straightforward. The type definitions carry most of the
documentation.

**Would I build with it again.** Yes, without hesitation.

---

## MCP Apps (SEP-1865)

**Used for:** six views served as `text/html;profile=mcp-app` resources, and a
host implementation in the simulator.

**What worked well.** Views as resources on the MCP connection is the right
decision. The host ships no markup; the card comes down the same connection as
the tool result, which means a card can never be out of step with the server that
produced it.

The CSP declaration in `_meta.ui` is a good idea done properly. Being able to say
`connectDomains: []` and mean it lets a server make a checkable claim about a
view, and I built the conformance test around exactly that: the suite reads the
served HTML and looks for `<script src>`, `@import` and `<link href>`, so the
declaration and the document have to agree.

**What needs work.**

- `ui/message` is attributed to the user, and the name does not say so. I got it
  wrong first. Friction log entry 3.
- `ui/notifications/size-changed` is fire-and-forget, so from inside a view a
  host that honoured the height and a host that ignored it are
  indistinguishable. Friction log entry 4.
- Two spellings of the tool-to-view link are in circulation and the deprecated
  one fails by rendering nothing. Friction log entry 5.
- Host behaviour varies more than the spec suggests. There are public reports of
  hosts stripping `_meta` out of `ui/notifications/tool-result` before forwarding
  it. CIRCA's views survive that because they read
  `params.result.structuredContent` and treat `_meta` as routing rather than as
  payload, but that was luck rather than design, and a conformance suite a host
  could run against itself would help more than another paragraph of
  specification.

**Would I build with it again.** Yes. Writing both halves against the
specification and then driving them against each other
(`tests/mcp-apps.test.ts`) is the way to use it, and once that test existed the
remaining questions were about product rather than protocol.

---

## AWS services

Four, all off by default, all behind an opt-in flag.

**Two of them have been run against AWS and two have not, and each entry below
says which.** DynamoDB held a real case in a real table on 2026-09-17, and a
model on Bedrock rephrased the refusal three times through the product's own
guard; the transcripts, the latencies and the defect the DynamoDB run exposed are
in `docs/AWS.md`. Textract and S3 were not run. Where an entry is written from
the API documentation and the SDK types rather than from use, it says so in its
first line, because feedback inferred from a type signature and feedback earned
from a failure are not the same thing and should not be read as though they
were.

### Amazon DynamoDB (`@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb`)

*Run against a real table on 2026-09-17: a case written, re-read, compared and
deleted. Everything below is from that run.*

**Used for:** the case store. One table, partition key the user, sort key the
case, optimistic concurrency through a condition expression on a version
attribute.

**What worked well.** `lib-dynamodb`'s document client removes the attribute-value
marshalling entirely, and the command factory pattern made the adapter injectable
without a mock framework. Nothing about the adapter needed to change to point it
at a real table: one environment variable, and the same case ids, the same
refusal and the same $4,030 / $420 / $200 decomposition came back out of DynamoDB
that came out of the file store.

**What needs work.** Two things, and the first one cost a working afternoon's
confidence.

`DynamoDBDocumentClient.from(client)` throws on an object holding an explicit
`undefined`, and the error names the option to set rather than the field that
carried it. On a record with forty optional fields, "which one" is the next
question and the SDK does not answer it. Defaulting `removeUndefinedValues` to
true, or refusing at client construction, would both be better than refusing at
the first write that happens to carry one. Full write-up as entry 7 of
`docs/FRICTION_LOG.md`.

The failure a conditional write produces is a `ConditionalCheckFailedException`
whose message says nothing about which condition failed. On a table with two
different condition expressions, that is the difference between a two-minute
diagnosis and an afternoon.

**The number that changed a design decision.** `GetItem` for one case, laptop in
Europe to `us-east-1`: 365 ms on the first call, then p50 102 ms and p95 104 ms
over the next twenty. CIRCA's slowest *tool* is 6.2 ms p95 against Alexa+'s
500 ms budget, so the store is seventeen times the entire engine and a cold first
call is most of the budget. That is not a complaint about DynamoDB — it is the
reason a voice add-on's table has to sit in the region the add-on is served from,
and the reason a Fargate task must not answer its first request cold. Neither
fact is visible from the API documentation.

**Would I build with it again.** Yes.

### Amazon Textract (`@aws-sdk/client-textract`)

*Not run against Textract. Everything below is read off the API documentation and
the SDK types, and the "what needs work" paragraph is a prediction about the
block model rather than a report of one.*

**Used for:** `DetectDocumentText` on a photographed estimate.

**What worked well.** The API split between `DetectDocumentText` and
`AnalyzeExpense` is a genuinely useful separation, and choosing the lower-level
one was a product decision rather than a cost one. `AnalyzeExpense` returns a
vendor's opinion about what the line items are, and the line items are precisely
what this product is arguing about.

**What needs work.** The block model is easy to misuse. Reconstructing reading
order from `LINE` blocks is left entirely to the caller, and a right-aligned
amount column is exactly the layout where a naive top-to-bottom read produces
plausible nonsense. A documented recipe for two-column financial documents would
save everybody the same afternoon.

**Would I build with it again.** For a document with structure I do not control,
yes.

### Amazon Bedrock (`@aws-sdk/client-bedrock-runtime`)

*Run against a model, on the voice path, on 2026-09-17: three rephrasings of the
refusal by `openai.gpt-oss-120b` through the Bedrock API endpoint, all three
accepted by `checkVoice`, 3.1 to 4.3 seconds each. The SDK `InvokeModel` path was
exercised as far as an account without a model-access agreement allows, which is
the subject of the "what needs work" paragraph.*

**Used for:** `InvokeModel` in two places: proposing a structure for a
photographed document, and rephrasing a deterministic sentence for voice.

**What worked well.** `InvokeModel` with an explicit body is the right level for
this. Both call sites needed to control exactly what crossed the boundary, and
being able to construct the request body directly is what made the nonce-delimited
document envelope possible without fighting an abstraction.

**What needs work.** **There is no way to ask "can I call this model" that a
developer would find, and there are three different failures that all look like
one.** This was measured rather than guessed, in an account with valid keys:

| state | the call that answers it | what a wrong guess returns |
|---|---|---|
| credentials resolve | the SDK provider chain | a key id, and no opinion at all |
| credentials authenticate | `sts get-caller-identity` | `InvalidClientTokenId` |
| the account is entitled | `bedrock get-foundation-model-availability` | `ValidationException: Operation not allowed` |
| the identity is permitted | the invoke itself | `AccessDeniedException`, naming the ARN |

`list-foundation-models` returned nineteen providers and ninety model ids for an
account entitled to none of them, because it describes the catalogue rather than
the caller — and it is the call everyone makes, because it is the one that hands
you the model id you are about to paste. `get-foundation-model-availability` is
the call that answers the question, and it is buried; it also rejects the
`...-v1` form of an id that `list-foundation-models` prints as `...-v1:0`,
inconsistently between the two.

The exception classes are the sharp edge. `AccessDeniedException` names the
action and the ARN and is a joy to debug. `ValidationException: Operation not
allowed` — the entitlement failure — names nothing, and reads exactly like a
malformed request body, so the first hour goes on the body. And root is refused
outright whatever its policy says, which means the one credential in the account
with unlimited IAM is the one credential guaranteed not to work, with no message
saying so.

Secondly, and much more minor: the model id is a long opaque string that varies
by region and appears in an IAM ARN, a config value and an environment variable,
and an inference-profile id (`us.anthropic.…`) needs a different ARN shape in the
policy from the foundation-model id it resolves to.

**What the endpoint gets right that the SDK path does not.** Against the same
account, the API endpoint answers a model you cannot use with
`permission_error: anthropic.claude-haiku-4-5 is not available for this account`,
naming the model and pointing at the console. That is the sentence `InvokeModel`
should have said instead of `Operation not allowed`. The token generator is a
local signature over the credential chain, so it needs no new secret and picks up
a rotated key without a restart; `getToken` requiring `credentials` explicitly
rather than reading the chain itself is one extra import, and worth it for the
clarity. And `/anthropic/v1/messages` speaking the Anthropic Messages API means the
request body `InvokeModel` already built goes through with one key dropped and one
added.

**The number that settles a design question.** 3.1 to 4.3 seconds per rephrasing
against a 500 ms Alexa+ round-trip budget. A model on the voice path cannot sit
inside a turn, whatever the model, so the deterministic sentence is the one that
ships. That was the design; now it is measured rather than assumed.

**Would I build with it again.** Yes, and I would keep the same discipline: the
model proposes and the code decides, with `groundProposal` and `checkVoice`
between the model and anything a customer sees. The fact that the model that
finally ran was not the family the code was written for, and nothing above the
transport noticed, is the discipline paying for itself.

### Amazon S3 (`@aws-sdk/client-s3`)

*Not run against S3.*

**Used for:** uploaded document images, read one object at a time by key.

**What worked well.** Nothing surprising, which is the correct outcome for this
service.

**Would I build with it again.** Yes.

### AWS CDK (`aws-cdk-lib` 2.268, `aws-cdk-lib/assertions`)

**Used for:** the stack the add-on would deploy to, and the tests that read it.

**What worked well.** `app.synth()` called directly from a script means synthesis
needs no credentials, no bootstrap and no CLI, so `pnpm cdk:synth` works on a
clean clone. `aws-cdk-lib/assertions` reading the synthesised template is the
right level to test infrastructure at: an IAM policy is a claim about a blast
radius, and asserting it against the template is asserting the thing that would
actually be applied.

**What needs work.** Two real problems, one of them serious.

Construct props that do nothing are accepted silently. I set an idle timeout on
`ApplicationListener.addTargets`, and the synthesised target group carried a
single `stickiness.enabled` attribute and no timeout at all. It is a load
balancer attribute, not a target group one. Nothing warned; the property was
accepted and discarded. For a Streamable HTTP server that holds a GET stream open
for server-to-client notifications, the consequence would have been a stream cut
at the 60-second default with no error anywhere. **A test that reads the template
found it. Reading the construct code would not have.**

`ContainerImage.fromAsset` did not apply the `.dockerignore` next to the
Dockerfile in the way I expected, and with `cdk.out` inside the repository the
staging copy included its own destination and never terminated. It reached 100 MB
of copied `node_modules` before I killed it. Passing `exclude` explicitly fixes
it, and so does putting `cdk.out` outside the asset directory, but a synthesis
that hangs with no output is a bad first experience.

**Would I build with it again.** Yes, and always with template assertions. The
silently-inert prop is the reason.

---

## Supporting tools, briefly

| | |
|---|---|
| **Node 22 / TypeScript 5.7** | `noUncheckedIndexedAccess` caught real defects in the parser. `verbatimModuleSyntax` off plus NodeNext resolution is the only combination that made the `imports` map, the SDK and CDK all resolve. |
| **zod v4** | `z.toJSONSchema()` is native, which is what makes the schema package worth extracting. `.default({})` on an object whose fields have their own defaults needs the defaulted fields supplied, which cost twenty minutes. |
| **vitest 3** | Real ports in tests need `pool: "forks"` without `singleFork`, or the conformance suite becomes a flake source. |
| **Vite 6 + React 18** | A Vite plugin that spawns the MCP server and proxies `/mcp` to it makes `pnpm simulator:dev` one command. Bundling the MCP SDK's browser client required no configuration at all. |
| **jsdom 30** | Does not implement iframe `srcdoc` and does not populate `MessageEvent.source`. Both are worked around explicitly in `tests/mcp-apps.test.ts`, and the source check is tested separately on fabricated events so the workaround is not hiding the thing it patches. |
