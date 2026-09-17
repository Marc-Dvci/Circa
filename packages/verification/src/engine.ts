import type { CaseFacts } from "#domain";
import type { VerificationCheck, VerificationReport } from "#schema";
import { assertSafeLanguage } from "#schema";
import { RULES } from "./rules.js";

/**
 * Run every rule, in a fixed order, and report the result as a checklist.
 *
 * There is no aggregation into a score, and there will not be one. "Five of nine
 * checks complete" is a fact about the record; "82% risk" is a number about a
 * named business that nobody can check, dispute or be corrected on.
 *
 * A rule that returns null is reported as NOT_APPLICABLE rather than omitted, so
 * the length of the list is a property of the product rather than of the case.
 * A checklist that quietly shrinks is one a user cannot tell apart from a
 * checklist that passed.
 */
export function runVerification(facts: CaseFacts): VerificationReport {
  const checks: VerificationCheck[] = RULES.map((rule) => {
    const result = rule.evaluate(facts);
    if (!result) {
      return {
        ruleId: rule.id,
        dimension: rule.dimension,
        label: rule.label,
        status: "NOT_APPLICABLE" as const,
        statement: "Not applicable to this case yet.",
        basis: { source: "CIRCA_POLICY" as const, reference: "CIRCA policy — a rule with no facts to read reports that it has none" },
        evidence: [],
      };
    }
    return { ruleId: rule.id, dimension: rule.dimension, ...result, label: rule.label };
  });

  const counts = {
    clear: checks.filter((c) => c.status === "CLEAR").length,
    verify: checks.filter((c) => c.status === "VERIFY").length,
    attention: checks.filter((c) => c.status === "ATTENTION").length,
    notApplicable: checks.filter((c) => c.status === "NOT_APPLICABLE").length,
  };

  const totalApplicable = checks.length - counts.notApplicable;
  return {
    caseId: facts.case.id,
    checks,
    counts,
    completedApplicable: counts.clear,
    totalApplicable,
    generatedAt: facts.now,
  };
}

/**
 * The order the product raises things in.
 *
 * ATTENTION first, then VERIFY with a next step, then the rest. Not by severity
 * — there is no severity — but by whether there is something the customer can do
 * about it in the next minute, because that is the only thing a voice interface
 * has room for.
 */
export function agenda(report: VerificationReport, limit = 4): VerificationCheck[] {
  const rank = (c: VerificationCheck): number => {
    if (c.status === "ATTENTION") return 0;
    if (c.status === "VERIFY" && c.nextStep) return 1;
    if (c.status === "VERIFY") return 2;
    return 3;
  };
  return [...report.checks]
    .filter((c) => c.status === "ATTENTION" || c.status === "VERIFY")
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, limit);
}

/**
 * The sentence CIRCA opens with.
 *
 * It denies a trust verdict on purpose and in those words, because the question
 * the customer actually asked — "are these people all right?" — is one the
 * product must not answer, and saying so plainly is better than answering a
 * different question and hoping nobody notices.
 */
export function summarise(report: VerificationReport, withRefusal = true): string {
  const { attention, verify } = report.counts;
  const open = attention + verify;
  if (open === 0)
    return assertSafeLanguage(
      `Every check I can run on what you have told me is complete: ${report.completedApplicable} of ${report.totalApplicable}.`,
    );
  // Said on the checklist that follows the offer, and not on every checklist
  // after it. It is the product's position and it has to be heard; a sentence
  // repeated verbatim four turns running stops being heard, and on two
  // consecutive turns it reads as the product not having listened.
  const sentences = withRefusal
    ? ["I can't tell you whether this contractor is trustworthy, and I am not going to try."]
    : [];
  if (attention > 0) {
    // Named, not counted. The card lists these conditions by name, and a voice
    // line that only counted them would make "everything a view shows, speech
    // has already said" false on the product's first screen.
    const named = listOf(report.checks.filter((c) => c.status === "ATTENTION").map((c) => c.label.toLowerCase()));
    sentences.push(
      `${withRefusal ? "What I can tell you is that " : ""}${attention} ${attention === 1 ? "condition here is" : "conditions here are"} worth knowing about: ${named}.`,
    );
  }
  if (verify > 0) {
    sentences.push(
      `${attention > 0 ? "And " : withRefusal ? "What I can tell you is that " : ""}${verify} ${
        verify === 1 ? "thing is" : "things are"
      } not established yet before you decide.`,
    );
  }
  return assertSafeLanguage(sentences.join(" "));
}

/** "a", "a and b", "a, b and c". */
export function listOf(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
