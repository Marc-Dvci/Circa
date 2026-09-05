# Terms of use

CIRCA is a hackathon project, published under the Apache License 2.0. It is
software for keeping a record and running a checklist, and it is not a
professional service.

## What CIRCA is

A tool that records what a contractor has offered, checks that record against
published consumer guidance, aligns two written quotes where both describe their
work, and holds the scope a customer says they accepted so that later requests
can be measured against it.

## What CIRCA is not

**It does not assess whether a contractor is trustworthy, competent, licensed,
insured or honest.** It reports only what it has been told and what it has not
been told, and the checklist says which is which. It has no connection to any
licensing board, insurer, credit bureau or trade body, and it does not verify any
claim against any external record.

**It is not legal, financial, insurance or construction advice.** The checklist
cites published consumer guidance from the United States Federal Trade Commission
and AARP, by URL, so that the source of each item can be read directly. Citing
guidance is not the same as giving advice, and CIRCA does not tell anyone whether
to accept an offer.

**It does not determine whether a price is fair.** Where two quotes both attach
their money to the work they describe, it reports where the difference sits.
Where they do not, it says so. Neither of those is an opinion about whether
either price is reasonable.

**It does not enter into, sign, pay for or cancel anything.** No operation in the
product commits the customer to a contractor. `accept_scope` records what the
customer says they accepted; it is a note to themselves, not an agreement with
anyone.

## The assessor directory is simulated

The thirty businesses in `fixtures/providers/providers.json` do not exist. No
name, licence number, rating or review count refers to a real company or person.
Every surface that shows them carries that notice.

## Accuracy

The parsing of a written quote is automated and can be wrong. Where the parser
cannot map work to a recognised component, the product reports unmapped work
rather than guessing, and where it cannot attribute a price difference it refuses
rather than estimating. Those refusals are the product working correctly. A
customer should read the documents themselves before making a decision, and CIRCA
is designed to tell them which parts of the documents to read.

## No warranty

Provided as is, without warranty of any kind, as set out in the Apache License
2.0. See [`../LICENSE`](../LICENSE).

## Data

See [`PRIVACY.md`](PRIVACY.md) for what is stored, where, and how to delete it.
