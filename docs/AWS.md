# AWS

**Two of the four integrations have been run against AWS. Two have not, and
nothing has been deployed.** That is the first paragraph because it is the one a
judge needs, and the rest of this document says exactly what was run, what came
back, and where the line is.

---

## What was actually run: DynamoDB, 2026-09-17

A real table, in a real account, holding a real case.

```
$ aws sts get-caller-identity
{
    "UserId": "416964654816",
    "Account": "416964654816",
    "Arn": "arn:aws:iam::416964654816:root"
}

$ aws dynamodb create-table --table-name circa-cases --region us-east-1 \
    --key-schema AttributeName=pk,KeyType=HASH AttributeName=sk,KeyType=RANGE \
    --global-secondary-indexes 'IndexName=byUser,KeySchema=[...],Projection={ProjectionType=ALL}' \
    --billing-mode PAY_PER_REQUEST
arn:aws:dynamodb:us-east-1:416964654816:table/circa-cases   ACTIVE

$ CIRCA_STORE=dynamodb CIRCA_TABLE=circa-cases AWS_REGION=us-east-1 pnpm check
  storage
  · store requested             dynamodb
  · store                       dynamodb (circa-cases)
  · store round trip            wrote a case, read it back, deleted it
```

Then the whole product, over that table: `circa new`, `circa offer`,
`circa quote` twice, `circa compare`, `circa dossier`. Same case ids, same
refusal on the lump sum, same decomposition on the itemised re-quote —
$4,030 of scope, $420 of rate, $200 unaccounted for — read back out of DynamoDB
rather than out of a file.

**Running it found a defect that seven test files did not.** The first
`circa quote` against the real table threw:

```
Pass options.removeUndefinedValues=true to remove undefined values from map/array/set.
```

CIRCA's records are full of explicit `undefined`s, because an optional field the
customer has not answered is a state this product is deliberately careful to
keep. The document client refuses to marshal one. The adapter's own suite is
green because `packages/store/src/dynamo-double.ts` marshals nothing — it
enforces the condition expressions, which is what it was written to do, and
marshalling was never in its remit. The fix is one option in
`packages/store/src/configure.ts`, and it is correct rather than expedient: a key
dropped on the way in is a key missing on the way back, which reads as
`undefined`, which is what it was.

### The latency, measured rather than assumed

`GetItem` for one case, from a laptop in Europe to `us-east-1`:

```
first call (TLS + credential resolution + SDK warm-up): 365 ms
next 20:  p50 102 ms   p95 104 ms   min 102 ms   max 104 ms
```

Put that next to the engine: the slowest CIRCA tool is **6.2 ms p95** against
Alexa+'s 500 ms budget. The store is **seventeen times the whole engine**, and
the first call of a cold task is most of the budget on its own. The product
conclusion is not "DynamoDB is slow" — it is that for a voice add-on the table
belongs in the region the add-on is served from, and that a Fargate task must not
serve its first request cold. Neither of those is visible from the API
documentation, and both changed what `infrastructure/cdk/stack.ts` should do.

**The table was deleted after the run.** It cost a few cents and it is
recreatable from the command above; nothing about this repository depends on it
existing.

## What was actually run: Bedrock, 2026-09-17, on the voice path

A real model, on Bedrock, rephrasing CIRCA's refusal, and the product's own
guard deciding whether to let it through.

```
$ AWS_PROFILE=otl-agent AWS_REGION=us-east-1 CIRCA_BEDROCK=1 \
  CIRCA_BEDROCK_ENDPOINT=https://bedrock-mantle.us-east-1.api.aws \
  CIRCA_MODEL_ID=openai.gpt-oss-120b pnpm check

  optional paths
  · bedrock                     on — API endpoint https://bedrock-mantle.us-east-1.api.aws
  · bedrock model               openai.gpt-oss-120b
  · bedrock round trip          4296 ms, sentence accepted by checkVoice
  · bedrock said                “Apex Exteriors is $6,500 and Nine Elms Exterior Surveys is
                                 $1,850, a difference of $4,650. I cannot set these side by
                                 side because one is a single pri…”
```

Three round trips: 4,296 ms, 3,851 ms, 3,122 ms. All three sentences carried
exactly the figures the payload carried and none it did not, so `checkVoice`
accepted all three. That guard is the product's answer to a model on the voice
path, and this is the first time it ran against something other than a scripted
model.

**The model is not the one the code was written for, and that is fine.** The
account cannot invoke Anthropic models — `InvokeModel` answers `Operation not
allowed` and the API endpoint answers `permission_error: anthropic.claude-haiku-4-5
is not available for this account` — but it can invoke `openai.gpt-oss-120b`.
CIRCA's design never depended on which model rephrases a sentence: the model
proposes and the code decides, and `apps/agent/src/bedrock.ts` folds a
chat-completions answer into the Messages shape so the callers stay ignorant of
the family. Fifteen lines, and the same guard runs either way.

**The number that settles a design question.** Three to four seconds a
rephrasing, against a 500 ms round-trip budget. A model on the voice path cannot
sit inside an Alexa+ turn, whatever the model. So the deterministic sentence is
the one that ships, and the rephrasing is what you would run ahead of time for
the fixed sentences, or not at all. That was the design already; now it is
measured.

**The transport.** Bedrock serves Anthropic models over the Anthropic Messages API
at `<endpoint>/anthropic/v1/messages` and other families over
`/v1/chat/completions`, authenticated with a twelve-hour bearer token minted
locally from the AWS credential chain (`@aws/bedrock-token-generator`). This is
the path an account without a model-access agreement can use, and it is the one
the console now leads with. `CIRCA_BEDROCK_ENDPOINT` selects it;
without it, `InvokeModel` through the SDK as before, and the CDK task role still
scopes that to one model ARN.

## What was not run: Textract, S3

Neither was run. Everything said about those two below is read off the API
documentation and the SDK types, and is labelled as such where it matters — see
`docs/PRODUCT_FEEDBACK.md`.

## What the Bedrock SDK path returned, before the endpoint was found

```
$ aws bedrock get-foundation-model-availability \
    --model-id anthropic.claude-haiku-4-5-20251001-v1 --region us-east-1
{
    "modelId": "anthropic.claude-haiku-4-5-20251001-v1",
    "agreementAvailability": { "status": "NOT_AVAILABLE" },
    "authorizationStatus": "NOT_AUTHORIZED",
    "entitlementAvailability": "AVAILABLE",
    "regionAvailability": "AVAILABLE"
}
```

The account can reach Bedrock, the region carries the model, and the identity
holds `bedrock:InvokeModel` — `AmazonBedrockFullAccess` was attached during this
session specifically to try. The model is still not invocable. Model access is an
account-level agreement accepted in the console, and this account has not
accepted one.

Three things in that response are worth separating, because they took three
attempts to tell apart:

- `entitlementAvailability: AVAILABLE` and `regionAvailability: AVAILABLE` say the
  model exists and this region serves it. Neither says anything about you.
- `AccessDeniedException` is IAM. Before the policy was attached, that is what
  came back, naming the exact action and ARN.
- `ValidationException: Operation not allowed` is entitlement. It is what comes
  back **after** IAM is satisfied, and it names nothing at all.

It is account-wide rather than a quirk of one model family. `openai.gpt-5.6-luna`
reads `NOT_AUTHORIZED` in the same account and region, as do the Sonnet and Haiku
ids; `list-foundation-models` cheerfully lists nineteen providers, none of which
this account may invoke. **A model appearing in `list-foundation-models` is not a
model you can call**, and nothing in the list response hints otherwise. Root is
refused outright whatever its policy says, so the one credential with unlimited
IAM is the one credential guaranteed not to work.

`aws bedrock get-foundation-model-availability` is the call that answers the
question, and it is not the call anyone reaches for.

That was the state for most of the final session, and it is why the endpoint path
above exists.

---

## The four integrations

Every one of them is off by default. The product is complete with all four off,
which is the property that lets a clean clone run the whole demo.

### Amazon DynamoDB, as the case store

`packages/store/src/dynamo.ts`. One table, partition key the user, sort key the
case, optimistic concurrency through a condition expression on the version.

```bash
CIRCA_STORE=dynamodb CIRCA_TABLE=circa-cases pnpm mcp
```

The adapter is tested against `packages/store/src/dynamo-double.ts`, which is not
an accepting stub. It **enforces** the two condition expressions the adapter
sends and throws on any expression it does not understand, and `tests/smoke.test.ts`
drives it into the conflict branch on purpose. A double that accepted every write
would let optimistic concurrency ship inverted with a green suite, which is the
kind of bug that surfaces as two people's edits silently overwriting each other
three months later.

### Amazon Textract, for reading a photographed document

`packages/documents/src/extract.ts`, `DetectDocumentText`.

```bash
CIRCA_TEXTRACT=1 pnpm mcp
```

`AnalyzeExpense` is the obvious API for a quote and is deliberately not used. It
returns a vendor's opinion about what the line items are, and the line items are
precisely the thing CIRCA is arguing about. Taking a structured answer from the
document-reading service would mean the product's central claim rested on an
extraction nobody could inspect.

The offline `PlainTextExtractor` is the default and the same interface, so adding
credentials swaps the extractor and changes nothing else. If the local path were
a different code route, the cloud path would be untested and the local path would
be the product.

### Amazon Bedrock, in two places

`apps/agent/src/bedrock.ts`. Two transports behind one `send()`: `InvokeModel`
through the SDK, default model `anthropic.claude-haiku-4-5-20251001-v1:0`, or
the Bedrock API endpoint with a bearer token, default model
`anthropic.claude-haiku-4-5`, any model id the account can invoke.

```bash
CIRCA_BEDROCK=1 AWS_REGION=us-east-1 pnpm mcp
CIRCA_BEDROCK=1 CIRCA_BEDROCK_ENDPOINT=https://bedrock-mantle.us-east-1.api.aws \
  CIRCA_MODEL_ID=openai.gpt-oss-120b pnpm mcp
```

**Reading a document.** A model proposes a structure for a two-column photographed
estimate with a handwritten total. `groundProposal` then discards every line and
every amount the document does not contain and re-derives the work units with the
same function the deterministic path uses.

**Saying it out loud.** A model rephrases the deterministic sentence, and
`checkVoice` rejects the result if it contains a monetary amount or a percentage
the payload does not contain, or if it trips `assertSafeLanguage`. On rejection
the deterministic sentence is spoken.

Both are tested against a scripted model, including a model that returns a line
item the document does not contain, which is the case that proves the grounding
is load bearing rather than decorative. A model that went missing would change
nothing about what CIRCA concludes.

### Amazon S3, for uploaded documents

The SDK is a dependency and the bucket is in the stack: encrypted, public access
blocked, versioned, uploads expiring after 90 days. The running server reads one
object at a time by key.

---

## The stack

```bash
pnpm cdk:synth     # writes dist/cdk.out/CircaStack.template.json
pnpm test          # tests/cdk.test.ts reads that template back
```

`infrastructure/cdk/app.ts` calls `app.synth()` directly rather than shelling out
to the CDK CLI, so synthesis needs no credentials, no bootstrap and no account,
and works on a clean clone. `cdk deploy` would need an account this project does
not have.

What it would create: a DynamoDB table, an S3 bucket, a two-AZ VPC, a Fargate
service behind an application load balancer, and a task role.

**The interesting part is the task role**, and it is asserted rather than
described. `tests/cdk.test.ts` reads the synthesised CloudFormation and checks:

- `s3:GetObject` on the upload prefix, and **no `s3:ListBucket`**. A defect that
  walks the bucket is a defect that reads another household's quote.
- `bedrock:InvokeModel` on one model ARN, never `*`. Changing model is a change
  to that file rather than something a prompt can reach.
- `textract:DetectDocumentText` and not `AnalyzeExpense`.
- no wildcard action anywhere in any statement.
- `CIRCA_AUTH=1` in the task environment, because a public endpoint without
  account linking is an open endpoint.

Writing the test found one defect that reading the construct code did not. The
load balancer's idle timeout was set on the target group, where the property is
accepted and produces nothing: the synthesised template carried a single
`stickiness.enabled` attribute and no idle timeout at all. Streamable HTTP holds
a GET stream open so the server can send a notification without being asked, and
a repair conversation spans a fortnight, so the load balancer's 60-second default
would have cut that stream underneath the session. It is now set on the load
balancer, where it belongs, and pinned at ten minutes.

## The container

`Dockerfile` runs the MCP server and only the MCP server: no simulator, no CLI,
no corpora. It runs as `node` rather than root, and its health check is the
`/health` endpoint that reports the negotiated protocol version, so a task that
came up against an SDK whose default had moved is unhealthy rather than quietly
serving.

It has not been built or pushed anywhere.
