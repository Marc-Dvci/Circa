# The model

Every number in CIRCA that is policy rather than arithmetic, in one place, with
the reason it is where it is. There are seven. Everything else the product
reports is counted, summed or compared.

The rule that governs all of them: **a threshold decides whether CIRCA is
willing to say something, never how strongly it says it.** There is no score
anywhere in this product, so no threshold ever contributes to one.

---

## 1. Itemisation: is the money attached to the work?

`packages/repair-schema/src/quote.ts`

| constant | value | what it decides |
|---|---|---|
| `ITEMISED_COVERAGE` | 0.90 | at or above this share of the total attached to priced line items, the quote is `ITEMISED` |
| `LUMP_SUM_COVERAGE` | 0.40 | below this, the quote is `LUMP_SUM` whatever it looks like; between the two it is `PARTIAL` |

Coverage is the sum of the priced line items divided by the stated total.

**Why 0.90 and not 1.00.** Real estimates carry a rounded total, a "materials and
labour" line, or a tax line that does not decompose. Requiring exact closure
would classify almost every genuine itemised quote as partial and the product
would refuse comparisons it can in fact make. Ten per cent is the slack an
honest document needs.

**Why 0.40 rather than a token amount.** A quote that prices one line and leaves
the rest of a five-figure total unexplained is a lump sum with a decoration on
it. Below 40 per cent, the priced part cannot carry a comparison of the whole.

**Coverage is necessary and not sufficient.** `Full roof replacement ....
$17,900` attaches 100 per cent of its total to a line item, so it reads as
perfectly itemised, and it still tells you nothing about where the money sits.
So `Side.lumpSum` in the comparison also fires when every priced line asserts a
container component. Coverage measures whether the money is on named lines. It
does not measure whether those lines name work at the granularity a comparison
needs, and conflating the two is what makes products claim to decompose a price
they cannot.

---

## 2. Comparison: can the difference be attributed?

`packages/normalizer/src/compare.ts`

| constant | value | what it decides |
|---|---|---|
| `MIN_OVERLAP` | 0.25 | below this Jaccard overlap of work units, the two documents are not describing the same job |
| `MIN_ATTRIBUTION` | 0.80 | each quote must attach at least this share of its total to line items before a residual is reported |
| `MAX_UNMAPPED_SHARE` | 0.10 | above this share of value in line items the taxonomy could not map, the alignment is not trusted |

**Why overlap is Jaccard over work units and not over line items.** Two quotes
describing the same job in different words have no lines in common and every unit
in common. The unit is `(component, action)`, so "Remove and replace chimney step
and counter flashing" and "Chimney flashing renewal" are the same unit and count
as overlap.

**Why 0.25.** A quarter is low on purpose. The alternative failure is worse:
refusing to compare a repair quote against an assessment that covers a subset of
it, which is the ordinary case when a second opinion looks at less than the first
contractor proposed. Below a quarter, the two documents are answering different
questions and the honest output names that (`NO_COMMON_SCOPE`) rather than
producing a residual nobody can act on.

**Why attribution is 0.80 here and itemisation is 0.90 there.** They answer
different questions. Itemisation labels a document. Attribution decides whether
this specific comparison can produce a number, and it is applied to both sides at
once, so the effective bar on a pair is higher than either threshold alone.

**Why unmapped value and not unmapped count.** Ten lines the taxonomy cannot read
that carry $200 between them do not threaten a $4,650 attribution. One line it
cannot read carrying $3,000 does. The share is computed over money.

**Overlap is computed over work the documents actually wrote.** Container
expansion ("full roof replacement" expands into its constituents so the
comparison can run at the finest granularity either document supports) is right
to report and wrong to count. Expanding a container against its own leaves adds
one present-in-one-quote-only entry per component and drives the overlap of a
document that exactly contains another down to 2 of 10.

### The four reasons a comparison refuses

Each is returned by name in `attribution.reason`, and each has a different
remedy, which is the point of separating them.

| reason | what happened | what the customer is told to ask for |
|---|---|---|
| `LUMP_SUM` | one side is a single number for a paragraph of work | the same quote itemised, with a price against each line |
| `INSUFFICIENT_ATTRIBUTION` | the priced lines do not add up to the total | the remaining work priced line by line |
| `UNMAPPED_WORK` | too much value sits in lines that name no recognised component | the work described in the trade's usual terms, one component per line |
| `NO_COMMON_SCOPE` | the two documents barely describe the same job | the second assessor to price the same list of work |
| `DIFFERENT_KIND_OF_WORK` | one of them is an assessment and not a repair | a repair quote from the same assessor |

The order these are tested in is load bearing. `LUMP_SUM` is checked before
`NO_COMMON_SCOPE`, because a spoken lump sum produces almost no work units and
its overlap with an itemised quote is therefore structurally low whatever the
documents say. Testing overlap first told the customer "these two barely describe
the same work", whose remedy is to ask the assessor to re-price, when the true
answer was "one of these was never itemised", whose remedy is to ask the
contractor to itemise. Only the second is actionable, and only the second is
true.

---

## 3. Deposit share

`packages/verification/src/rules.ts`

| constant | value | what it decides |
|---|---|---|
| `DEPOSIT_ATTENTION_SHARE` | 1/3 | above this share of the total, the deposit is worth telling the customer about |
| `DEPOSIT_LARGE_SHARE` | 0.50 | at or above this, the schedule is a single payment in all but name |

The FTC's guidance is that payments should be tied to completed stages and that
paying in full before the work is done is the thing to avoid. It does not publish
a percentage. So the shape of the advice is cited to the FTC and the number is
labelled `CIRCA_POLICY`, because a threshold presented as somebody else's
guidance when it is ours is the kind of borrowed authority this product exists to
argue against.

A deposit above these shares raises `ATTENTION`, which in this product means
"worth knowing about". It does not mean the contractor is doing anything wrong,
and no wording in the product suggests that it does.

---

## The four statuses

Every rule returns exactly one of these, and a rule that does not apply is
reported rather than dropped.

| status | means | raised by |
|---|---|---|
| `CLEAR` | established from something recorded | a positive fact on the case |
| `VERIFY` | not established | absence of a fact, always |
| `ATTENTION` | a positively recorded condition worth knowing about | a recorded fact, never an absence |
| `NOT_APPLICABLE` | this rule has nothing to say about this job | the rule's own guard |

**`undefined` is not `false`.** "The customer has not told me whether they were
shown the damage" and "the customer was not shown the damage" are different
facts. Only the second can raise `ATTENTION`. This one rule is the whole of the
false-alarm control, and it is why 24 ordinary repairs in the scenario corpus
produce zero findings while the 24 that should produce findings produce all of
them.

**Why `NOT_APPLICABLE` is reported.** A checklist that silently drops
inapplicable items shrinks, and a shorter checklist looks like a cleaner one. The
customer should be able to see that a rule about permits said nothing because the
job needs no permit, not because it passed.

---

## Language

`assertSafeLanguage` in `packages/repair-schema/src/verification.ts` throws on
thirteen patterns. It is a function that raises, not a linter that warns, and
every rule statement, every spoken sentence and every refusal passes through it
before it leaves the process.

The patterns cover verdicts about people (trustworthy, honest, reputable,
scammer, legitimate), recommendations to act (you should sign, do not hire), and
certainty this product cannot have (guaranteed, definitely overcharging). There
are two negated exemptions, for the one sentence the product does say:

> I can't tell you whether this contractor is trustworthy, and I am not going to
> try.

A model is involved in exactly one place that produces spoken text, and its
output is checked by `checkVoice` before it is spoken: a generated sentence is
rejected if it contains a monetary amount or a percentage the payload does not
contain, or if it trips the same language check. On rejection the deterministic
sentence is spoken. There is no third option and no repair loop, because a
sentence that has to be argued into safety is a sentence to discard.

---

## What has no threshold

Worth stating, because the absence is a decision.

- **No confidence score on a component match.** A component is assigned when one
  of its lexemes appears literally in the text, and otherwise it is not assigned.
  There is no similarity measure to tune.
- **No ranking weight on assessors.** Providers are ordered lexicographically:
  independence first, then availability, then rating. A weighted sum would need
  an exchange rate between "better reviews" and "sells the repair it is
  assessing", and there is no defensible one.
- **No aggregate over the checklist.** Five of nine complete is reported as five
  of nine.
