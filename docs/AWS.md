# AWS

**Nothing in this project has been deployed to AWS, and no AWS API has been
called with a working credential.** That is the first sentence because it is the
one a judge needs, and the rest of this document says exactly what exists,
exactly what was run, and exactly where the line is.

---

## What was actually run

```
$ aws sts get-caller-identity
An error occurred (InvalidClientTokenId) when calling the GetCallerIdentity
operation: The security token included in the request is invalid.
```

Credentials are present on the machine and they resolve. `pnpm doctor` runs the
SDK's own provider chain, the same chain a client uses at the moment it matters,
and gets an access key id and a region back:

```
  aws
  · aws region                  eu-west-1
  · aws credentials             resolved (AKIA…JADV)
  ! aws credentials note        resolving is not the same as being accepted
```

The distinction in that last line is the point, and it is why `pnpm doctor`
prints it as a warning rather than a tick. A credential that resolves through the
provider chain has passed no test at all. STS is the thing that decides, and STS
says no.

So: the four AWS integrations below are written, typed against the vendor SDKs,
and driven in tests against injected doubles. They have not been run against
AWS itself, and no number in this repository comes from an AWS API.

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

`apps/agent/src/bedrock.ts`, `InvokeModel`, default model
`anthropic.claude-3-5-haiku-20241022-v1:0`.

```bash
CIRCA_BEDROCK=1 AWS_REGION=us-east-1 pnpm mcp
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
