import type {
  AgreementBaseline,
  ScopeChange,
  ScopeChangeReview,
  ScopeChangeVerdict,
  VerificationCheck,
  WorkUnit,
} from "#schema";
import { actionsOverlap, assertSafeLanguage, formatCents, workKey } from "#schema";
import { covers, labelFor } from "#taxonomy";
import { BASIS } from "./basis.js";

/**
 * Review a proposed change against the accepted scope.
 *
 * This is the part of the product that only works because the earlier part
 * happened. Nothing here is clever: the baseline was recorded when the customer
 * accepted it, and the question is whether the work now being described is in
 * it. What makes it valuable is that the alternative — remembering — is what
 * everybody currently does, three weeks later, with a crew on the roof.
 */

function inBaseline(unit: WorkUnit, baseline: AgreementBaseline): WorkUnit | undefined {
  const exact = baseline.work.find((b) => workKey(b) === workKey(unit));
  if (exact) return exact;
  return baseline.work.find((b) => covers(b.component, unit.component) && actionsOverlap(b.action, unit.action));
}

export function reviewScopeChange(
  change: ScopeChange,
  baseline: AgreementBaseline | undefined,
  unmappedText: readonly string[] = [],
  now = new Date().toISOString(),
): ScopeChangeReview {
  const checks: VerificationCheck[] = [];
  const push = (
    ruleId: string,
    status: VerificationCheck["status"],
    statement: string,
    basis: VerificationCheck["basis"],
    nextStep?: string,
  ): void => {
    const c: VerificationCheck = {
      ruleId,
      dimension: "PROPOSAL",
      status,
      statement: assertSafeLanguage(statement),
      basis,
      evidence: [change.id],
    };
    if (nextStep) c.nextStep = assertSafeLanguage(nextStep);
    checks.push(c);
  };

  if (!baseline) {
    push(
      "change.no_baseline",
      "VERIFY",
      "Nothing has been recorded as accepted on this case, so there is no agreed scope to measure this against.",
      BASIS.CIRCA_BASELINE,
      "Record what was agreed first. After that, every later request can be compared with it.",
    );
    return {
      caseId: change.caseId,
      changeId: change.id,
      verdict: "UNDETERMINED",
      alreadyAgreed: [],
      newWork: change.work,
      unmapped: [...unmappedText],
      changeAmountCents: change.amountCents,
      checks,
      generatedAt: now,
    };
  }

  const alreadyAgreed: WorkUnit[] = [];
  const newWork: WorkUnit[] = [];
  for (const unit of change.work) {
    if (inBaseline(unit, baseline)) alreadyAgreed.push(unit);
    else newWork.push(unit);
  }

  let verdict: ScopeChangeVerdict;
  if (change.work.length === 0 || unmappedText.length > 0) verdict = "UNDETERMINED";
  else if (newWork.length === 0) verdict = "WITHIN_BASELINE";
  else if (alreadyAgreed.length === 0) verdict = "OUTSIDE_BASELINE";
  else verdict = "PARTIALLY_OUTSIDE";

  const increaseFraction =
    change.amountCents !== undefined && baseline.totalCents > 0 ? change.amountCents / baseline.totalCents : undefined;

  // ── the finding ──────────────────────────────────────────────────────────
  if (verdict === "WITHIN_BASELINE") {
    push(
      "change.outside_baseline",
      "CLEAR",
      `Everything described here is already inside what you accepted on ${baseline.acceptedAt.slice(0, 10)}.`,
      BASIS.CIRCA_BASELINE,
      change.amountCents !== undefined
        ? "If it is already in the agreed scope, it is worth asking what the extra charge is for."
        : undefined,
    );
  } else if (verdict === "UNDETERMINED") {
    push(
      "change.outside_baseline",
      "VERIFY",
      unmappedText.length > 0
        ? `Part of what is being proposed could not be matched to anything in the agreed scope: ${unmappedText.join("; ")}.`
        : "Nothing specific enough to compare has been recorded about what is being proposed.",
      BASIS.CIRCA_BASELINE,
      "Ask for the proposed work in writing, naming the component and the quantity.",
    );
  } else {
    const names = newWork.map((w) => labelFor(w.component));
    push(
      "change.outside_baseline",
      "ATTENTION",
      `${names.join(", ")} ${names.length === 1 ? "is" : "are"} not in the scope you accepted on ${baseline.acceptedAt.slice(0, 10)}. I have recorded this as a proposed change, not as approved work.`,
      BASIS.CIRCA_BASELINE,
      "A written change order, naming the work and the price, is the normal way to agree this.",
    );
  }

  // ── the conditions around it ─────────────────────────────────────────────
  if (change.writtenChangeOrderProvided === true)
    push("change.written_order", "CLEAR", "A written change order has been provided.", BASIS.FTC_WRITTEN_CONTRACT);
  else
    push(
      "change.written_order",
      "VERIFY",
      "No written change order has been recorded.",
      BASIS.FTC_WRITTEN_CONTRACT,
      "Ask for the additional work and its price in writing before it starts.",
    );

  if (change.conditionDocumented === true)
    push("change.condition_documented", "CLEAR", "The condition that prompted this has been documented.", BASIS.CIRCA_EVIDENCE);
  else
    push(
      "change.condition_documented",
      "VERIFY",
      "The condition that prompted this has not been documented.",
      BASIS.CIRCA_EVIDENCE,
      "A photograph of what was found, taken where it was found, before it is covered up again.",
    );

  if (change.revisedCompletionDateGiven === false || change.revisedCompletionDateGiven === undefined)
    push(
      "change.revised_date",
      "VERIFY",
      "No revised completion date has been recorded for the extra work.",
      BASIS.FTC_WRITTEN_CONTRACT,
      "Extra work moves the finish date. Ask what it moves to.",
    );
  else push("change.revised_date", "CLEAR", "A revised completion date has been given.", BASIS.FTC_WRITTEN_CONTRACT);

  if (verdict === "OUTSIDE_BASELINE" || verdict === "PARTIALLY_OUTSIDE") {
    push(
      "change.concealed_clause",
      baseline.concealedDamageClause ? "CLEAR" : "VERIFY",
      baseline.concealedDamageClause
        ? "The agreement you accepted does contemplate conditions found after work begins, so this kind of request is provided for. The price for it still is not."
        : "The agreement you accepted does not say anything about conditions found after work begins.",
      BASIS.CIRCA_BASELINE,
      baseline.concealedDamageClause
        ? "Ask which clause covers it and what rate it sets."
        : "Worth asking how it is meant to be handled, in writing, before agreeing.",
    );
  }

  if (increaseFraction !== undefined && increaseFraction > 0) {
    push(
      "change.increase_share",
      "VERIFY",
      `${formatCents(change.amountCents!)} is ${Math.round(increaseFraction * 100)} per cent on top of the ${formatCents(baseline.totalCents)} you accepted.`,
      BASIS.CIRCA_BASELINE,
    );
  }

  const review: ScopeChangeReview = {
    caseId: change.caseId,
    changeId: change.id,
    verdict,
    alreadyAgreed,
    newWork,
    unmapped: [...unmappedText],
    baselineTotalCents: baseline.totalCents,
    checks,
    generatedAt: now,
  };
  if (change.amountCents !== undefined) review.changeAmountCents = change.amountCents;
  if (increaseFraction !== undefined) review.increaseFraction = increaseFraction;
  return review;
}

export function explainScopeChange(review: ScopeChangeReview): string[] {
  const lines: string[] = [];
  const attention = review.checks.find((c) => c.ruleId === "change.outside_baseline");
  if (attention) lines.push(attention.statement);
  const open = review.checks.filter((c) => c.status === "VERIFY" && c.nextStep);
  if (open.length > 0) lines.push(`Before you agree: ${open[0]!.nextStep}`);
  return lines.map(assertSafeLanguage);
}
