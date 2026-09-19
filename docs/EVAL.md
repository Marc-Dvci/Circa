# Evaluation

```bash
pnpm eval              # all three corpora and the engine inventory
pnpm eval --scenarios  # 48 repairs, half of them ordinary
pnpm eval --quotes     # 14 labelled quote pairs
pnpm eval --injection  # 16 attacks and 8 controls
pnpm eval --lexicon    # what the engine actually contains
pnpm eval --transfer   # two sets labelled before they were read, reported apart
```

Exit code 0 means every metric met its bar. The corpora are checked into
`fixtures/`. No name, licence number or rating in them refers to a real company
or person.

---

## Scenarios: does it stay quiet on an ordinary job?

**48 repairs, 24 of them ordinary jobs where silence is the correct output.**

| metric | result |
|---|---|
| false alarms on ordinary jobs | **0.0%** (0 of 24) |
| ATTENTION precision | 100.0% |
| ATTENTION recall | 100.0% |
| scenarios fully correct | 48 of 48 |
| forbidden language emitted | 0 |
| assessment requests that leaked the first opinion | 0 |

The false-alarm rate is the number that matters and it is the reason half the
corpus is ordinary. A product that tells homeowners what to watch for on a home
repair is one bad threshold away from telling them to distrust a decent
contractor doing a normal job, and a corpus made only of suspicious cases cannot
detect that. The 24 ordinary repairs are ordinary in
the ways that trip a naive rule: a heat pump replacement with staged payments, a
roof job whose deposit is exactly a third, a slab leak the insurer has already
confirmed, a gas company that shut a furnace down before the engineer arrived, an
unsolicited gutter-guard sale with no urgency attached to it.

Zero false alarms is a consequence of one design decision rather than of tuning:
`ATTENTION` requires a positively recorded condition, and an absence is only ever
`VERIFY`. See `docs/MODEL.md`.

Two of the metrics are properties rather than accuracy. `forbidden language
emitted` runs every generated sentence in every scenario back through
`assertSafeLanguage`, and `assessment requests that leaked` runs `findAnchoring`
over every generated scope to check that the first contractor's price, name and
urgency claim are absent from a request that is supposed to be independent.

---

## Quote pairs: does it refuse when it should?

**14 labelled pairs, 6 of which cannot be attributed.**

| metric | result |
|---|---|
| correct refusals (recall) | **100.0%** |
| refusals that were right (precision) | **100.0%** |
| verdict accuracy | 100.0% |
| component alignment accuracy | 100.0% |
| pairs fully correct | 14 of 14 |

The refusals are the harder half. A comparison engine that always produces a
number scores zero on them, and a comparison engine that never produces one
scores zero on the other eight. The ground truth on each pair is the alignment
between the two documents' work units and, where the difference is attributable,
which reason applies when it is not.

Precision matters as much as recall here: refusing a comparison that could have
been made is a product that tells a customer to go back to a contractor for no
reason.

---

## Injection: what reaches the agent as an instruction?

**16 documents carrying text addressed to an automated reader, 8 ordinary quotes
as controls.**

| metric | result |
|---|---|
| containment failures | **0** |
| detection recall | 100.0% |
| controls that tripped the detector | 0 |

The two metrics measure different things and are reported separately on purpose.

**Detection may miss. Containment must be zero.** A detector is a label shown to
the user, and any pattern list can be evaded by a sentence nobody has thought of
yet. What actually stops the attack is architectural: document text enters
through `isolate()`, is parsed by code, and where a model is involved arrives
inside a nonce-delimited envelope whose rules precede it. A model's proposed
structure is then filtered by `groundProposal`, which discards any line that does
not appear in the document and any amount the document does not contain.
`docs/THREAT_MODEL.md` has the argument in full.

Detection by category, all 16 found:

| category | documents |
|---|---|
| instruction override | 3 |
| role reassignment | 2 |
| tool direction | 2 |
| output constraint | 3 |
| exfiltration | 3 |
| urgency escalation | 2 |
| hidden channel | 2 |

The 8 controls are ordinary estimates chosen for the ways a real document
resembles an attack: one whose notes address the reader politely, one that
carries an email address legitimately, one that quotes the customer's own written
instructions back at them, one written in lower case with sparse lines, and a
condition report that proposes no repair at all. A detector that fires on those
makes the label useless, so the control false-positive rate is a scored metric
rather than a note.

---

## Transfer: what does it read on estimates it was not built on?

**Two sets of estimates, each labelled before the engine read it. Reported,
never gated.**

```bash
pnpm eval --transfer   # both sets, per document and per format
pnpm eval --holdout    # the held-out set alone
```

The three corpora above were written alongside the engine, so they measure
regression discipline. These two measure transfer, and the order of the commits
is the evidence:

| set | estimates | labelled against | committed | then |
|---|---|---|---|---|
| 1 | 28 | engine at `cc2a5a5` | `f1ff496` | read, and the parser changes in `6a62ce8` were made against it |
| 2 | 24 | engine at `6a62ce8` | `c82124f` | read once |

Set 1 is now development data. Set 2 is the held-out number. Each priced line
carries the taxonomy ids a reader would say it proposes, the ids a reader would
accept on it, and the work on it that the taxonomy has no id for. The formats
are the ones a product meets outside a demo: estimate-software columns, an
insurance adjuster's estimate and a supplement, scanned and handwritten tickets,
pounds sterling, Canadian and Australian terms, Spanish, emails and text
messages, options and good/better/best tiers, credits, tax, overhead and profit,
allowances, wrapped descriptions, pipe tables.

| | set 1, first read | set 1 now | **set 2, held out** |
|---|---|---|---|
| priced lines read | 85.1% (114 of 134) | 100% (134 of 134) | **94.6%** (105 of 111) |
| read lines mapped to their work | 60.2% (62 of 103) | 92.6% (113 of 122) | **73.1%** (57 of 78) |
| proposed components found | 73.9% (116 of 157) | 93.0% (146 of 157) | **83.5%** (76 of 91) |
| lines asserting work not proposed | 9, $12,419 | 5, $18,092 | **9, $34,300** |
| options or summaries read as work | 5, $23,985 | 0 | **2, $26,750** |
| money on work outside the taxonomy | $24,010 of $149,484 | same | **$24,946 of $106,517** |
| documents fully read | 1 of 28 | 17 of 28 | **9 of 24** |

**Coverage is the failure mode, as a lexicon predicts.** On the held-out set,
23% of the priced money is on work the taxonomy has no id for: a TPO membrane,
a water softener, deck boards, a line set, a chimney rebuild, 38 named pieces of
work across 28 lines. The lexicon grew from 777 to 861 forms on set 1, and set 2
still found that share. An unmapped line is carried as unclassified money, the
way "Seal penetrations" is in the demo, so it lowers what a comparison can
attribute and never adds work to either side.

**Asserted work is the costlier error, and set 2 names its sources.** A
good/better/best proposal put $26,750 of unselected tiers into the proposal.
Two exclusions written in brackets ("paint excluded", "painting by owner") were
read as painting. An invoice's "Amount due" line was read as a line item, which
doubled its total. One estimate printed its amounts as `4,980.00 USD`, and none
of its six lines was read. Room names without a trade noun ("Hallway and
stairwell walls") mapped four of six painting lines to nothing.

**What set 1 changed** (`6a62ce8`, pinned by seven tests in
`tests/normalizer.test.ts`): amounts with no currency sign, in pounds, leading
the line, or in brackets as a credit; pipe tables; descriptions that wrap onto
the line carrying their amount; option, alternate and add-on lines held out of
the total and the proposal; tax and credit lines read as money and never as
work; totals and deposits stated in a sentence; table column headings; "by
others" as an exclusion; a bare system name read as the whole system only when
its own clause says what is done to it; and 84 regional and trade forms, from
"consumer unit" and "switchboard" to "eavestrough", "downpipe" and "pipe jack".
The three corpora above stayed at 0% false alarms, 100/100 refusals and zero
containment failures through every one of these changes.

---

## The engine, counted

| | |
|---|---|
| taxonomy components | 103, across 5 trades |
| lexical forms | 861 |
| phrases claimed by two components | 12 |
| verification rules | 18, across 4 dimensions |
| injection detectors | 22, across 7 categories |

The twelve ambiguous phrases are enumerated rather than resolved. "Cap" is a chimney
cap or a capacitor, "vent" is a ridge vent or a flue, "valve" is three plumbing
components the trade cannot settle between. Where the trade disambiguates them,
the normaliser uses the trade; where it does not, the phrase maps to nothing and
the comparison reports unmapped work rather than guessing.

---

## What the corpora found

Seven defects, all in code that 38 passing unit tests had already covered. Each
is fixed and pinned by a test.

1. **The refusal named a symptom that the lump sum itself caused.**
   `compareQuotes` tested `NO_COMMON_SCOPE` before `LUMP_SUM`. A spoken lump sum
   produces almost no work units, so its overlap with an itemised quote is
   structurally low whatever the documents say, and the customer was told "these
   two barely describe the same work" (remedy: ask the assessor to re-price)
   instead of "one of these was never itemised" (remedy: ask the contractor to
   itemise). Only the second is true and it is the demo's whole arc.

2. **A decking line was read as a whole-roof replacement.**
   `roof.full_replacement` carried the verb-phrase lexemes "replace roof" and
   "replace the roof". Two words beat "decking" at one, so `Replace roof decking,
   6 sheets .... $4,030` asserted a full roof replacement with the decking's money
   attached to it. Bare system names now live in a fallback lexicon that fires
   only when the clause named no component at all.

3. **Container expansion was inflating the overlap denominator.** Expanding "full
   roof replacement" against "eight shingles" adds one present-in-one-quote-only
   entry per component the wide quote covers, which is right to report and wrong
   to count. A container against its own leaves scored 2 of 10 and came back as
   two documents that barely describe the same job. Overlap is now computed over
   work the documents actually wrote.

4. **A quote can attach 100 per cent of its total to line items and still be a
   lump sum.** `Full roof replacement .......... $17,900` is one priced line, so
   coverage was perfect. `Side.lumpSum` now also fires when every priced line
   asserts a container.

5. **The assessor's own letterhead was deciding whether two quotes could be
   compared.** Trades name themselves after what they do, so `NINE ELMS EXTERIOR
   SURVEYS — assessment and repair estimate` produced an unpriced `gen.inspection`
   work unit, and one unpriced non-shared unit is enough to make a whole
   comparison unattributable. Unpriced lines carrying the known contractor name,
   or set in capitals, are now skipped, along with labelled prose (`Observed:`,
   `Not inspected:`, `Terms:`). A line with money on it is a line item whatever it
   looks like.

6. **A contractor asking for more money is evidence the job started.**
   `recordScopeChange` was not advancing `DECISION_RECORDED` to
   `WORK_IN_PROGRESS`, so the timeline recorded a change against a job that had
   not begun.

7. **A door was appearing on a roofer's inspection list.** `buildNeutralScope`
   seeded its list from every component the description mentioned, and "they
   knocked on the **door** and said the flashing has failed" put a door on it. It
   now seeds only from components of the case's trade.

Six earlier defects were found the same way, by writing tests against the demo
scenario rather than by reading the code. The one worth repeating: **negation
scope was computed after punctuation was stripped**, so "Replace 8 shingles; no
decking observed" became one segment, the negation cue in its second half applied
to the whole thing, and a quote that promised shingles was recorded as excluding
them. Segmentation now runs on the raw text.

---

## The model paths

Both Bedrock paths are exercised against a scripted model, including a model
that returns a line item the document does not contain, which is the case that
proves `groundProposal` is load bearing. The voice path also ran against Bedrock
itself with `openai.gpt-oss-120b`: three rephrasings of the comparison answer,
all three accepted by `checkVoice`, 3.1 to 4.3 seconds each. `docs/AWS.md` has
the transcript and the design decision that latency settled.
