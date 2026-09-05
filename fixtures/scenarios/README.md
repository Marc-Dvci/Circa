# Scenario corpus

Forty-eight repairs. **Twenty-four of them are ordinary jobs where the correct
output is silence** — a licensed firm the homeowner called, a fair deposit, a
written estimate, a normal price. The other twenty-four contain at least one
condition that published consumer guidance names.

The split is the point. A product that tells homeowners to slow down before
paying a contractor is only useful if it stays quiet on a normal job, and the
number that says whether it does is the false-alarm rate on the legitimate half,
not the recall on the other one. Any checklist can find every condition by
raising every condition.

Every scenario declares `expectAttention`: the rule ids that must come back
`ATTENTION`, and no others may. `ATTENTION` is reserved for a *positively
recorded* condition — a deposit share that was stated, a payment method that was
demanded, a door knock the customer described. An absence is never `ATTENTION`;
it is `VERIFY`, which is a question rather than a finding. That distinction is
the whole of the false-alarm control, and this corpus is where it is measured.

Only four of the seventeen rules can return `ATTENTION` at all:

| rule | fires when |
|---|---|
| `conditions.unsolicited` | the customer says the contractor arrived unprompted |
| `conditions.immediate_decision` | a decision was asked for today or immediately |
| `conditions.deposit_share` | a stated deposit exceeds a third of a stated total |
| `conditions.payment_method` | the only methods offered are cash or wire |

Run it:

```bash
pnpm eval                 # every corpus
pnpm eval --scenarios     # this one, with the per-scenario table
```

Fields are in dollars, because that is what the tool surface takes. `answers`
are the verification questions the customer answered; anything omitted stays
"not established", which is a different fact from "no".
