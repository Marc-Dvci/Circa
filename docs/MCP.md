# The MCP surface

CIRCA is a self-hosted MCP server. Protocol **2025-11-25**, Streamable HTTP,
sixteen tools, six MCP Apps views.

```bash
pnpm mcp                                  # http://localhost:8787/mcp
curl -s http://localhost:8787/health      # protocol, tools, views, store, sessions
curl -s http://localhost:8787/metrics     # p50 / p95 / max per tool
```

The protocol version is asserted rather than declared.
`tests/mcp-conformance.test.ts` connects the SDK's own
`StreamableHTTPClientTransport` to the server over a bound port and reads
`transport.protocolVersion` after a real `initialize`. A hand-rolled client
agreeing with a hand-rolled server would agree on any version at all, including
one Alexa+ rejects.

---

## Transport

Streamable HTTP, stateful. A session id is issued on `initialize` and every later
request carries it; `POST`, `GET` and `DELETE` are all served.

Stateless would have been less code, and it would also have meant a new
`McpServer` per request, which is fine until the first
`notifications/tools/list_changed`. A repair conversation spans a fortnight and
is exactly the case where a server wants to be able to say something without
being asked. One transport per session, one server per transport, torn down
together, with `onsessionclosed` removing the map entry rather than leaving it
for a sweep that does not exist.

`/health` reports the version the SDK will negotiate and the version Alexa+
requires as two separate fields. Folding them into `"ok": true` would be green on
the day the SDK's default moves.

---

## The sixteen tools

Twelve of these are the tool surface the product was specified with. Four were
added while building it, and each earned its place for a stated reason.

| tool | what it does |
|---|---|
| `start_repair_case` | Opens a persistent record. Everything else hangs off the `caseId` it returns. |
| `capture_offer` | Records what a contractor proposed: the description in the customer's words, the price, any deposit, how the contractor was found, and any urgency claim. |
| `get_verification_status` | What has and has not been established. |
| `answer_verification_question` | Answers one of the open questions. Only fields the customer actually answered are passed. |
| `structure_scope` | Writes the independent assessment request, and returns the list of what it withheld and why. |
| `find_independent_professionals` | Assessors who could look at this, ordered by how little they gain from the answer. |
| `request_second_opinion` | Sends the neutral scope to one of them. |
| `add_quote` | Adds a written quote and parses it into work units. |
| `compare_quotes` | Aligns the work and either attributes the price difference or names why it cannot. |
| `record_scope_change` | Records a mid-job request for more money and reviews it against the accepted scope. |
| `review_scope_change` | Re-runs that review on a change already on file. |
| `get_repair_dossier` | The whole record: quotes, what was accepted, changes, timeline. |
| **`accept_scope`** | *Added.* Writes the baseline. Without it, `review_scope_change` has nothing to compare against, and the specification had a tool that reads a record nothing wrote. |
| **`set_change_status`** | *Added.* A change moves from proposed to documented to accepted or declined. Leaving that transition out would have made the change review a report rather than something the customer can act on and come back to. |
| **`list_repair_cases`** | *Added.* A record that survives across conversations has to be findable in the next one. "What repairs do you have for me" has no other answer. |
| **`delete_repair_case`** | *Added.* A product that stores a household's contracts and offers no way to remove them is a product with a privacy claim it cannot honour. See `docs/PRIVACY.md`. |

### Two conventions, both promises to the model

**Money crosses this boundary in dollars.** A model that has just heard "six
thousand five hundred" emits `6500`. A schema that said cents would be a schema
the model violates by a factor of a hundred while validating cleanly. Dollars in,
integer cents one line later, and nothing downstream sees a float.

**Every input is honoured.** Amazon's guidance is that the model treats an MCP
schema as a promise. There is no field here the service ignores, and where the
product cannot do something there is no parameter for it.

### The tools hold no logic

`apps/mcp-server/src/tools.ts` contains no threshold, no wording decision and no
arithmetic on money beyond the dollars-to-cents conversion at the boundary. Every
handler is a translation of one `CaseService` operation, and every result is
built by `apps/agent/src/present.ts`.

That claim is kept true by a second caller that would notice if it stopped being
true. `pnpm circa` reaches the same service and prints the same payloads, so a
rule that migrated into a tool handler would be a rule the CLI does not have.

### Errors

A thrown error becomes a spoken sentence with `isError: true`, never a stack
trace. `get_verification_status` on an unknown case answers "I do not have a
record of that repair. Say check a repair and I will open one."

**It used to read the case id back**, which was both a worse sentence and a
breach of the Alexa+ functional requirement that no internal identifier reach a
customer-facing response. An error is a customer-facing response.
`tests/mcp-conformance.test.ts` now asserts the id is absent rather than present,
which is the same test with its sign corrected.

---

## The six views

MCP Apps, SEP-1865. Each view is a resource on the MCP connection with
`mimeType: text/html;profile=mcp-app`, and each tool result names the view that
should render it through the nested `_meta.ui.resourceUri`. The flat
`_meta["ui/resourceUri"]` spelling is deprecated in the final text and is not
used; the conformance suite asserts its absence, because it still appears in
circulating examples.

| uri | shows |
|---|---|
| `ui://circa/verification` | The checklist. Open items, the deposit, the quoted price. |
| `ui://circa/comparison` | Two quotes side by side, and the part of the difference the documents can and cannot account for. Prefers fullscreen. |
| `ui://circa/change` | A newly proposed piece of work measured against the accepted scope. |
| `ui://circa/providers` | Assessors, with the reason each is in that position. |
| `ui://circa/scope` | The assessment request, and what was deliberately left out of it. |
| `ui://circa/dossier` | The whole record and the timeline. Prefers fullscreen. |

### The views load nothing

`_meta.ui.csp.connectDomains` and `resourceDomains` are both empty arrays. That
is a claim about the document rather than a preference: these views fetch
nothing, load no font and call no analytics. The conformance suite asserts both
the declaration and the document, checking the served HTML for `<script src>`,
`@import` and `<link href>`, because a view that declared a domain would be a
view a contractor's document could eventually reach through.

### Voice-only is the baseline

Everything a view shows, the result's `speech` has already said. That is enforced
by construction: `present.ts` builds `speech`, `rows` and `actions` in one place,
and the views contain no product logic at all, so a screen showing four open
items beside a voice line saying three is not possible without changing the
payload both read.

A host that does not understand the UI extension ignores the `_meta` key and
still receives a complete spoken answer.

---

## The wire, both halves

`apps/mcp-server/src/ui/runtime.ts` is the view half, inlined into every view
(about 90 lines, no dependencies). `apps/simulator/src/host.ts` is the host half.
They were written from the specification separately, and
`tests/mcp-apps.test.ts` drives one against the other in a real DOM over the
documented message names, so a rename on either side is a failing test rather
than a card that stops updating.

| direction | message | used for |
|---|---|---|
| host to view | `ui/notifications/tool-result` | the whole `CallToolResult`, which is what the model saw |
| host to view | `ui/notifications/tool-input` | the arguments, before the result exists |
| host to view | `ui/notifications/host-context-changed` | display mode, theme, locale |
| view to host | `ui/notifications/size-changed` | measured after every render, not only the first |
| view to host | `ui/request-display-mode` | the comparison card asks for room before it draws the long form |
| view to host | `ui/message` | the dossier card speaks as the customer, so a tap lands in the transcript |
| view to host | `ui/update-model-context` | the assessor card reports which business was picked on screen |
| view to host | `tools/call` | every button that changes the case |
| view to host | `ui/open-link` | requested by nothing in CIRCA; the host refuses it and answers with an error |

**`ui/message` is the customer speaking, not the product.** The dossier card's
"Compare the quotes" button sends it, and the host runs the result through the
same planner a spoken sentence goes through. On a product whose output is a
record, a tap that changed the case without appearing in the transcript would
make the record wrong in the one place it has to be right.

**`ui/update-model-context` is for state the conversation never heard.** Picking
an assessor from a list is a choice made with a finger. Telling the model which
one was picked is what makes "book that one" resolve afterwards.

**A request is answered.** `tools/call`, `ui/request-display-mode` and
`ui/open-link` are requests: the view is waiting on a JSON-RPC result. A host that
only listens leaves a button spinning. The spec allows a host to grant a display
mode other than the one asked for, so the granted mode is echoed back rather than
assumed, and this host answers `pip` with `inline` because the page cannot
produce a picture-in-picture card and saying yes to a mode it cannot draw is how
a card ends up at a size no device has.

### Isolation

The view runs in an iframe with `sandbox="allow-scripts"` and nothing else, which
gives it an opaque origin. `event.origin` is therefore the string `"null"` and
proves nothing, so the host checks `event.source === iframe.contentWindow`, which
is the identity that holds. A view rendering a contractor's document is the last
place to be relaxed about this. `tests/mcp-apps.test.ts` drives a message from a
window that is not the hosted view and asserts it is dropped.

---

## Latency

Alexa+ publishes a round-trip budget of under 500 ms. `pnpm bench` drives twenty
complete repairs, 360 calls, through the SDK's client over Streamable HTTP and
reports what the client waited, including JSON-RPC framing, the HTTP round trip
and schema validation of both the arguments and the structured output.

```
  slowest tool at p95              request_second_opinion at 6.2 ms
  Alexa+ round-trip budget         500 ms
  headroom at the slowest tool     493.9 ms
  first call of the process        10.7 ms  (cold path, excluded from the quantiles)
```

The hop is loopback, so this measures the add-on and not the network to it. What
it answers is whether CIRCA's own work is a meaningful fraction of the budget,
and it is not: the deployment decides the latency and the product does not. The
server's own per-handler timings are always smaller and are at `/metrics`.
