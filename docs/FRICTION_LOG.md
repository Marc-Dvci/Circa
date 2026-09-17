# Friction log

Seven entries. Every claim about a documented behaviour was re-read on the live
documentation page before this file was written, and every claim about code
points at a file in this repository that a reader can open. Where I could not
establish what a product does, the entry says that rather than guessing, because
an entry that is wrong about Amazon's own product is worse than no entry.

Severity uses one scale: **high** blocks a working submission, **medium** costs
hours or forces a decision on incomplete information, **low** is a papercut that
a sentence of documentation removes.

---

## 1. The documented 401 and RFC 9728 §5.1 disagree, and the page does not say which wins

**Severity: medium.**

**Task.** Implement account linking for a self-hosted MCP add-on so that an
unauthenticated `tools/call` tells the client where to get authorised.

**Steps.** Read
[Account Linking for Category MCP Add-ons](https://developer.amazon.com/docs/alexaplus/add-ons/category-sdk-mcp-account-linking.html).
Implement the 401 against RFC 9728 §5.1, which says a protected resource
responding 401 SHOULD include a `WWW-Authenticate` header carrying a
`resource_metadata` parameter pointing at
`/.well-known/oauth-protected-resource`. Compare that with the example on the
page.

**Expected.** The documented 401 example includes the header, or the page states
that Alexa+ ignores it and reads the metadata document directly.

**Actual.** The page's 401 example is a JSON body and nothing else:

```
HTTP/1.1 401 Unauthorized
Content-Type: application/json

{
  "error": "unauthorized",
  "message": "Access token required to use this tool."
}
```

The header is not mentioned anywhere on that page. The page also asks for a
metadata document at `/.well-known/oauth-protected-resource` without citing RFC
9728, so a server author reading it cannot tell whether omitting the header is
required, permitted, or simply unmentioned.

**The answer exists, on a different page, in a list titled something else.** The
[MCP QuickStart Guide](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-quickstart.html)'s
authentication checklist says it twice:

> Your MCP server returns 401 Unauthorized (**without a `WWW-Authenticate`
> header**) for unauthenticated requests.

and then, under **Not Supported Yet**, alongside Dynamic Client Registration,
CIMD, OIDC and step-up authorization:

> `WWW-Authenticate` header in 401 responses.

So it is required to be absent, and that is a deliberate narrowing of RFC 9728
rather than an omission. It is also filed under "not supported yet" next to four
features a server may *choose* not to use, which reads as permission rather than
a requirement. The one page that answers it is the quickstart, which an
implementer reads first and then leaves, and the question only forms later on the
account-linking page.

**Workaround.** Send the documented shape. `apps/mcp-server/src/oauth.ts`
answers 401 with `resource_metadata` in the JSON body and no header, and
`tests/oauth.test.ts` asserts the header is absent so the deviation stays
deliberate rather than being restored by somebody tidying up.

**Suggestion.** Put the sentence on the account-linking page too, where the 401
example is, and say it as a requirement rather than as an unsupported feature:
"Do not send `WWW-Authenticate`; Alexa+ reads the JSON body." Citing RFC 9728 as
the source of the metadata endpoint, and naming this as a deliberate narrowing of
§5.1, would let an implementer stop wondering which document is stale.

---

## 2. `resource` is required on two legs of three, and the asymmetry is easy to implement wrongly

**Severity: low.**

**Task.** Bind the access token to this MCP endpoint so a token minted for
another resource by the same issuer cannot open it.

**Steps.** The page states that Alexa "includes this as a `resource` parameter in
both the authorization request and the token exchange request but not in the
token refresh request".

**Expected.** Having read "the `resource` parameter is required", validate its
presence on every request that reaches the token endpoint.

**Actual.** Doing that breaks refresh, because refresh does not carry it. The
sentence is correct and complete, and it is one clause inside a parameter table.
An implementer who reads the table row and writes the obvious validation has a
server that works through the whole first link and fails an hour later when the
first token expires, which is the worst place for this class of bug to surface.

**Workaround.** Require `resource` on the authorization request, and on the token
endpoint validate it only when present, matching it against the value the code was
bound to. `tests/oauth.test.ts` drives both: a missing `resource` at authorize is
`invalid_request`, and a mismatched one at token exchange is `invalid_target`.

**Suggestion.** Give the refresh exception its own line in the flow description
rather than a trailing clause in a parameter table. The failure it causes is
delayed by exactly one token lifetime.

---

## 3. MCP Apps: `ui/message` reads as "the view says something", and it is the opposite

**Severity: medium.**

**Task.** Add a button to a comparison card that shows the long explanation the
customer just heard summarised.

**Steps.** Read the SEP-1865 message list. Pick `ui/message` for a view that
wants text to appear in the conversation. Implement:
`HOST.displayMode("fullscreen").then(() => HOST.say(detail))`.

**Expected.** From the name, `ui/message` posts a message into the conversation
from the view, which is what a card showing an explanation wants.

**Actual.** `ui/message` inserts a message **as the user**. The implementation
above put CIRCA's own explanation of a price difference into the transcript
attributed to the customer, on a product whose entire output is a record of who
said what. It rendered correctly and read plausibly, which is why it survived
until the transcript was read next to the card.

The correct division took a second reading: `ui/message` is for a view acting on
the user's behalf, `ui/update-model-context` is for telling the model about state
the conversation never heard, and a view that simply wants to show more of what
it already has should ask for room and draw it.

**Workaround.** All three are now used for what they are for.
`apps/mcp-server/src/ui/views.ts`: the comparison card requests fullscreen and
renders its own detail; the dossier card sends `ui/message` with "Compare the
quotes", which is genuinely the customer speaking; the assessor card sends
`ui/update-model-context` naming the business picked on screen, so a following
"book that one" resolves. `tests/mcp-apps.test.ts` drives each one.

**Suggestion.** Name the direction in the method: `ui/user-message`. Failing
that, one line in the description saying the message is attributed to the user,
because the current name reads as the view's own voice and a host will happily
render either.

---

## 4. MCP Apps: `ui/notifications/size-changed` is fire-and-forget, so a clipped card is invisible to the view

**Severity: medium.**

**Task.** Make a card that grows by a row when a comparison becomes attributable
display all of its rows.

**Steps.** Measure `document.documentElement.scrollHeight` after every render and
send `ui/notifications/size-changed`. Implement the host side and honour it.

**Expected.** Some way for the view to learn what height it was actually given,
so that a view can adapt when a host declines or clamps the request.

**Actual.** It is a notification. There is no response and no field in
`ui/notifications/host-context-changed` reporting the granted height, so from
inside the view a host that resized correctly and a host that ignored the message
are indistinguishable. A card whose last two lines are below the fold looks, from
the view's side, exactly like a card that fits. This is the failure mode that
only shows up on a device nobody tested on.

It matters more than it looks because hosts differ here in practice: hosts have
already been reported stripping `_meta` out of `ui/notifications/tool-result`
before forwarding it to the view, so "the host did something other than what the
message asked" is a live category rather than a hypothetical one.

**Workaround.** Report after every render rather than once on load, and keep
every card's content short enough that the inline height is sufficient. In the
host built here, `apps/simulator/src/host.ts` honours the height and clamps it to
a device-sized range, and `tests/mcp-apps.test.ts` asserts the report is sent
after each render rather than only the first.

**Suggestion.** Either make it a request that resolves with the granted height,
or add `viewport` to the `host-context-changed` payload. Either lets a view
degrade deliberately instead of hoping.

---

## 5. The MCP Apps tool-to-view link has two spellings in circulation, and the wrong one fails silently

**Severity: low.**

**Task.** Link a tool result to the view that should render it.

**Steps.** Search for examples. Find `_meta["ui/resourceUri"]` in a
November-2025 proposal and in sample code derived from it. Find
`_meta.ui.resourceUri` in the shipped specification.

**Expected.** One spelling, or a loud failure on the wrong one.

**Actual.** Both appear. The nested form is what shipped and the flat form is
deprecated; conformance tooling accepts the flat form and reports a warning, and
a host that only reads the nested form renders nothing at all for a server that
sends the flat one. Nothing about that failure points at the spelling: the tool
succeeds, the result is correct, and the card is simply absent.

**Workaround.** Use the nested form, and assert the absence of the flat one.
`tests/mcp-conformance.test.ts` checks every tool that declares a view for
`_meta.ui.resourceUri` and asserts `_meta` has no `ui/resourceUri` key, so a copy
from an old example is a failing test.

**Suggestion.** Where the deprecated form is accepted, surface it as a visible
warning in the host as well as in conformance tooling. A silent card is the
hardest of the three outcomes to diagnose.

---

## 6. The AWS SDK's credential chain resolves credentials that STS then refuses, and nothing cheap distinguishes them

**Severity: medium.**

**Task.** Before writing a deployment path, find out whether this machine can
reach AWS.

**Steps.** Run the SDK's own provider chain, which is what any client uses at the
moment it matters:

```ts
const client = new DynamoDBClient({});
await client.config.region();       // "eu-west-1"
await client.config.credentials();  // resolves, an access key id
```

Then call STS.

**Expected.** A credential that resolves is a credential that works, or the
resolution reports that it could not be validated.

**Actual.**

```
$ aws sts get-caller-identity
An error occurred (InvalidClientTokenId) when calling the GetCallerIdentity
operation: The security token included in the request is invalid.
```

The chain resolved a key that no AWS service will accept. That is correct
behaviour, since resolution is a local operation and validation is a network one,
and it is still a trap: a health check written the obvious way reports AWS as
available, and the first thing to discover otherwise is whichever feature runs
first in front of a user. Two sibling projects in this same hackathon reported the
identical error, so this is the state a hackathon machine is commonly in.

**There is a second rung on the same ladder, and it is the one that cost most.**
A credential that STS accepts is still not a credential that can invoke a model.
Bedrock answers `AccessDeniedException` while IAM is unsatisfied and
`ValidationException: Operation not allowed` once IAM is satisfied and the
account holds no model-access agreement — a different exception type, naming no
action and no resource, for a condition one console click away. Meanwhile
`list-foundation-models` returns nineteen providers regardless, because it
describes the catalogue rather than the caller.

So there are three distinct states that all look like "AWS works": resolved,
authenticated, entitled. Each has its own call, each fails with a different
exception class, and only the last one is checked by
`get-foundation-model-availability` — the call nobody reaches for, because the
listing call already returned the model id you were about to use.

**Workaround.** Report the two facts separately and never infer one from the
other. `pnpm check` prints the resolved key with a warning line saying that
resolving is not the same as being accepted, and names `aws sts
get-caller-identity` as the thing that decides. Every AWS path in the product is
behind an opt-in flag, and the product is complete with all of them off.

**Suggestion.** A documented one-call validation helper on the credential
provider chain, or a note in the chain's documentation that resolution implies
nothing about validity. The current documentation describes where credentials
come from and not what "resolved" guarantees, and the gap between those two is
where a deployment plan gets built on a credential that was never going to work.

---

## 7. `DynamoDBDocumentClient` refuses an explicit `undefined`, and a table double will never tell you

**Severity: medium.**

**Task.** Run CIRCA's case store against a real DynamoDB table rather than
against the double the suite uses.

**Steps.** Create the table, point the product at it, and record one case:

```bash
aws dynamodb create-table --table-name circa-cases --billing-mode PAY_PER_REQUEST ...
CIRCA_STORE=dynamodb CIRCA_TABLE=circa-cases circa quote <case> --file quote.txt
```

**Expected.** The same behaviour as the file store. The adapter is driven end to
end by `tests/smoke.test.ts`, including the optimistic-concurrency conflict
branch, against a double that enforces the condition expressions rather than
accepting every write.

**Actual.**

```
Pass options.removeUndefinedValues=true to remove undefined values from map/array/set.
```

`DynamoDBDocumentClient.from(client)` throws on an object holding an explicit
`undefined`. CIRCA's records are full of them by design: `contractorName`,
`deposit` and `concealedDamageClause` are optional, and an optional field the
customer has not answered is a state this product is careful to preserve —
`undefined` is not `false` is the first rule in `packages/verification/src/rules.ts`.
`pnpm check`'s round trip passed, because the record it writes is a minimal case
with every optional field absent rather than present-and-undefined.

**The general shape is what makes it worth logging.** The double was written to
enforce the thing the adapter is interesting for, which is the condition
expression. It marshals nothing, because marshalling is the SDK's job and the
double is not the SDK. So the one behaviour the adapter could not get wrong under
test was the one it got wrong, and seven green test files and a green health
check all agreed. A test double shares the bug it was not written to have.

**Workaround.** `marshallOptions: { removeUndefinedValues: true }` in
`packages/store/src/configure.ts`, which is correct here rather than expedient: a
key dropped on the way in is a key absent on the way back, and an absent key
reads as `undefined`, which is what it was.

**Suggestion.** Default `removeUndefinedValues` to true, or throw at client
construction rather than at the first write that happens to carry one. The error
names the option and not the field, so on a record of any size the next question
is "which one", and the answer is a `JSON.stringify` replacer written at the
moment you least want to write one.

---

## What is not in this log

Things that cost time and were my own fault: a container asset staged into its own
output directory and never finished copying; a load balancer idle timeout set on
the target group, where the property is accepted and produces nothing. Both are
recorded where they belong, in `docs/AWS.md` and in the code, and neither is
friction with somebody else's product.
