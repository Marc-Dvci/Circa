# Evaluation

```bash
pnpm eval              # all three corpora and the engine inventory
pnpm eval --scenarios  # 48 repairs, half of them ordinary
pnpm eval --quotes     # 14 labelled quote pairs
pnpm eval --injection  # 16 attacks and 8 controls
pnpm eval --lexicon    # what the engine actually contains
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

## The engine, counted

| | |
|---|---|
| taxonomy components | 103, across 5 trades |
| lexical forms | 777 |
| phrases claimed by two components | 10 |
| verification rules | 18, across 4 dimensions |
| injection detectors | 22, across 7 categories |

The ten ambiguous phrases are enumerated rather than resolved. "Cap" is a chimney
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
