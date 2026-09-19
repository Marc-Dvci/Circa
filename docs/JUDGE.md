# Five minutes

In order. Everything runs on a clean clone with no AWS account, no credentials
and no API keys.

```bash
git clone https://github.com/Marc-Dvci/Circa
cd Circa
pnpm install
```

---

## 1. See the argument (60 seconds)

```bash
pnpm demo
```

Fourteen real MCP tool calls over Streamable HTTP against the SDK's own client,
in about 50 ms. Watch for two beats.

**The refusal**, at `compare_quotes`:

> I cannot set these side by side, because one of these is a single price for
> everything it describes, so there is no way to tell which part of the money
> belongs to which piece of work. That is a property of the document, not of the
> roof.
>
> Ask for the same quote itemised, with a price against each line. Then the same
> comparison can answer it.

**The payoff**, at the second `compare_quotes`, after the customer asked for the
itemised version and the contractor sent it:

```
Different scope               $4,030
Same work, different price    $420
Unaccounted for               $200
```

and, spoken:

> $200 is not accounted for by either, and all of it sits on one line I could not
> classify: "Seal penetrations". That is the line to ask about.

A residual is a subtraction, so it usually has a name. Handing the customer the
number without the name leaves them to invent the question; handing them the line
lets them read it off the quote.

Same call, same code, different documents. The product's advice changed what the
product could compute. That is the whole thesis: a price difference is not a
finding until the scopes are aligned, and it is not attributable at all unless
both documents put their money against the work they describe.

`pnpm demo --tour` runs it slower and prints why each beat is there.

---

## 2. See it as an Alexa+ host (2 minutes)

```bash
pnpm simulator:dev
```

Open <http://localhost:5173>. Press **Play the demo**.

The status bar is live. `protocol 2025-11-25` is `transport.protocolVersion`
after a real `initialize`, not a constant this page chose. The dev server started
the MCP server as a separate process; the page connects to it with the MCP SDK's
own Streamable HTTP client.

The left pane is the conversation as a voice-only Echo would have it: the exact
strings in each tool result's `content`. The right pane is the Echo Show card,
which is an MCP Apps view fetched with `resources/read` and rendered in a
sandboxed iframe. Read them side by side. Everything the card shows, the
transcript already said, which is what makes voice-only a first-class path here
rather than a degraded one.

Two things worth doing:

- Press **show the MCP Apps wire** and then press **Explain the difference** on
  the comparison card. `ui/request-display-mode` goes out, the host answers, the
  card redraws into the room it was granted.
- Type something the planner does not know, such as *what is the weather like in
  Boston*. It says it did not follow, and offers what it can do. It does not
  reach for an adjacent tool, which is the failure mode that costs somebody
  money.

---

## 3. Check the numbers (90 seconds)

```bash
pnpm eval
```

Three corpora. The two numbers to read first:

```
false alarms on ordinary jobs     0.0%  (0 of 24)
correct refusals                  100.0%  (recall)
```

**Zero false alarms on 24 ordinary repairs** is the number that matters for a
product that tells homeowners what to watch for. Half the scenario corpus is
deliberately ordinary: a heat pump replacement with staged payments, a roof job
whose deposit is exactly a third, a slab leak the insurer has already confirmed.
A corpus made only of suspicious cases cannot detect the failure that matters.

**6 of the 14 quote pairs cannot be attributed, and the engine gets all 6
right**, with no false refusals. A comparison engine that always produces a
number scores zero on the refusals; one that never produces a number scores zero
on the other eight.

**On 24 held-out estimates, 94.6% of priced lines are read and 73.1% of those
map to the work they propose.** That set was labelled against a frozen engine
and committed before it was read (`c82124f`), in formats the corpora above do
not contain. It reports what the lexicon misses, by money: 23% of the priced
total is work the taxonomy has no id for. `docs/EVAL.md`, "Transfer", has both
sets and every failure by name.

The third corpus reports detection and containment separately on purpose.
Detection may miss; containment must be zero, and is.

```bash
pnpm bench     # 360 calls over the wire: slowest tool 6.2 ms at p95, budget 500 ms
pnpm verify    # typecheck, 114 tests, the three corpora and both transfer sets
pnpm check    # what is actually live here
```

---

## 4. Read three files (90 seconds)

If you read nothing else in the source:

**`apps/agent/src/present.ts`** — the one place that decides what a result says.
Three surfaces read a case and a fourth, voice, is the one that matters. The
payload is built once here, complete with the sentence to speak and the rows to
draw, so a screen showing four open items beside a voice line saying three is not
possible.

**`packages/normalizer/src/compare.ts`** — the refusal. Five named reasons, each
with a different remedy, and an ordering that is load bearing: `LUMP_SUM` is
tested before `NO_COMMON_SCOPE` because a spoken lump sum produces almost no work
units and its overlap is therefore structurally low whatever the documents say.
Testing overlap first told the customer to ask the wrong person for the wrong
thing.

**`packages/store/src/dynamo-double.ts`** — a table double that *enforces* the two
condition expressions the adapter sends and throws on anything it does not
understand. A double that accepted every write would let optimistic concurrency
ship inverted with a green suite.

---

## What to look at if you have longer

| | |
|---|---|
| [`docs/MODEL.md`](MODEL.md) | The seven policy numbers in the product and the reason for each. Everything else is counted or compared. |
| [`docs/EVAL.md`](EVAL.md) | The corpora, and the seven defects they found in code that 38 passing unit tests already covered. |
| [`docs/THREAT_MODEL.md`](THREAT_MODEL.md) | A contractor's own document is the attacker-controlled channel. Four things stop it, and the detector is last. |
| [`docs/FRICTION_LOG.md`](FRICTION_LOG.md) | Eight entries. Every documented behaviour re-read on the live page before it was written down. |
| [`docs/AWS.md`](AWS.md) | Four integrations, none deployed, and exactly why. |
| [`docs/MCP.md`](MCP.md) | The 16 tools, the 6 views, and the SEP-1865 wire in both directions. |

---

## What this project declines to do

Worth knowing before you look for it.

There is **no score**. No risk percentage, no trust rating, no aggregate over the
checklist. Aggregating items that are not comparable invents a comparison.

`undefined` **is not** `false`. "Not told" and "no" are different facts, and only
a positively recorded condition can raise `ATTENTION`. That single rule is the
whole of the false-alarm control.

It **will not say whether a contractor is trustworthy**. It says exactly that,
and then gives the checklist. Thirteen forbidden language patterns are enforced
by a function that throws, and every rule statement and spoken sentence passes
through it.

**Nothing is deployed to AWS.** The credentials on the build machine resolve
through the SDK's provider chain and are refused by STS with
`InvalidClientTokenId`. Every AWS path is written, typed against the vendor SDKs,
tested against enforcing doubles, and off by default.
