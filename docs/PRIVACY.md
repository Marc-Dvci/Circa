# Privacy

CIRCA holds the record of a home repair somebody is deciding about. That record
contains a household's contractor, the price they were quoted, what they were
told, and what they agreed to. It is not incidental data, and this document says
what happens to it.

---

## What is stored

Per repair case, and nothing outside this list:

| | |
|---|---|
| the customer's own description of what is wrong | verbatim, as spoken |
| what the contractor proposed | verbatim, as the customer reported it |
| business or contractor name, where given | |
| the quoted price and any deposit | integer cents |
| how the contractor was found, and any urgency claim | as recorded |
| answers to the checklist questions | tri-state: yes, no, or not asked |
| the text of any quote added | as supplied |
| the accepted scope, once accepted | written once, never rewritten |
| changes proposed during the job, and their status | |
| a timeline of every operation | append-only |
| a postal code, only if given | used to find local assessors, nothing else |

**What is not stored.** No address, no telephone number, no email address, no
payment details, no photographs unless a document is uploaded, no location beyond
a postal code, and no identifier for the contractor beyond the name the customer
used.

There is no analytics, no telemetry and no third-party call anywhere in the
default path. `/metrics` reports per-tool latency and nothing about content, and
it is served only to whoever can reach the server.

## Where it is stored

One environment variable decides, and `pnpm check` prints which is live.

| `CIRCA_STORE` | where | notes |
|---|---|---|
| `file` (default) | `.state/cases/<caseId>.json` on the machine running the server | one JSON document per case, written to a temporary file and renamed into place |
| `memory` | nowhere | lost on exit; what the tests and `pnpm demo` use |
| `dynamodb` | one table, partitioned by user | needs `CIRCA_TABLE` and credentials |

There is no silent fallback from `dynamodb` to `file`. Asking for DynamoDB
without a table name raises rather than quietly writing locally, because a demo
that appears to persist to the cloud when it does not is a demo that misleads
about where a household's contract went.

The DynamoDB table has no global secondary index. There is no query in this
product that crosses households, and an index that permits one is a query
somebody eventually writes.

## Deleting it

```
"Delete this repair."
```

`delete_repair_case` removes the case, its quotes, the accepted scope, every
change and the whole timeline. It is annotated `destructiveHint: true`, it cannot
be undone, and the product says so when it has done it:

> Deleted. The quotes, the accepted scope and the whole timeline are gone, and I
> cannot get them back.

`pnpm circa delete <caseId>` does the same thing from a terminal, against the
same store.

## Retention

Nothing expires on its own in the default file store. A case stays until it is
deleted.

In the deployed shape (`infrastructure/cdk`), uploaded document images expire
after 90 days. A photographed quote has done its job once it has been parsed and
the structure is on the case; keeping the image for a year would be keeping a
household's paperwork for a year.

---

## The second-opinion request

This is the one place CIRCA sends information somewhere else, and it is the place
where what is *not* sent matters most.

When the customer asks for an independent assessment, CIRCA writes the request
itself. It deliberately removes:

- the price the first contractor quoted
- the first contractor's business name
- any urgency claim they made
- their diagnosis, as a conclusion

and sends the symptom, the area, and the list of components an assessor should
look at. The list of what was withheld is shown to the customer with the reason
for each, and `findAnchoring` reads the generated text back against the case to
check that nothing leaked rather than trusting that nothing did. The scenario
corpus scores that check across all 48 cases: zero leaks.

The reason is not privacy for its own sake. A second opinion that is handed the
first opinion is not a second opinion, and a stated price sets the range an
independent quote is drawn towards.

## Documents

A document read with Amazon Textract is sent to Textract. That path is off unless
`CIRCA_TEXTRACT=1` is set; without it, documents are read as plain text locally.
A document read with a model is sent to Amazon Bedrock. That path is off unless
`CIRCA_BEDROCK=1`. `pnpm check` prints which of these are on.

Both are off by default, and the product is complete with both off.

## Who can read a case

Every `CaseService` operation is keyed by user. With `CIRCA_AUTH=1` that user is
the subject of the linked account's token, bound to the MCP session at
`initialize`; without it, it is `CIRCA_USER`, which defaults to a single demo
user because a local clone has one person using it.

That binding is asserted rather than described. `tests/oauth.test.ts` links two
accounts against one running server, opens a repair on the first, and requires
the second not to see it. Before that test existed the token was validated, its
subject was attached to the request, and nothing read it back — so every session
shared one user id, and the second household to link would have been shown the
first household's contract. The gate being correct said nothing about who the
cases belonged to.

The MCP endpoint is gated by a bearer token when `CIRCA_AUTH=1`, and that token
is bound to this specific endpoint by RFC 8707, so a token minted for another
resource by the same issuer does not open it. See `docs/AUTH.md`.

## What CIRCA never records

No judgement about a person. There is no field on a contractor for
trustworthiness, reliability or reputation, because there is no such field to
fill in honestly, and thirteen language patterns are enforced in code to keep one
from appearing in a sentence. The checklist records what was established and what
was not, and both of those are facts about a transaction.
