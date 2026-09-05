import type { Comparison, Quote } from "#schema";
import { assertSafeLanguage, formatCents } from "#schema";

/**
 * The sentences the product says about a comparison.
 *
 * Written here, deterministically, from the comparison object — not generated.
 * A model may rephrase these for voice, and when it does the rephrasing is
 * checked against the same numbers before it is spoken (`apps/agent/src/voice.ts`),
 * because the one thing that must never happen is a fluent sentence carrying a
 * figure the comparison does not support.
 */

const NOT_IDENTIFIABLE: Record<string, string> = {
  LUMP_SUM:
    "one of these is a single price for everything it describes, so there is no way to tell which part of the money belongs to which piece of work",
  INSUFFICIENT_ATTRIBUTION:
    "too little of at least one total is attached to specific line items to say where the difference sits",
  UNMAPPED_WORK:
    "some of the described work could not be matched to anything comparable, so the difference cannot be split up reliably",
  NO_COMMON_SCOPE: "these two documents barely describe the same work",
  DIFFERENT_KIND_OF_WORK: "one of these is an inspection and the other is a repair",
};

export function explainComparison(comparison: Comparison, quoteA: Quote, quoteB: Quote): string[] {
  const nameA = quoteA.contractorName ?? "the first quote";
  const nameB = quoteB.contractorName ?? "the second quote";
  const lines: string[] = [];

  lines.push(
    `${nameA} is ${formatCents(quoteA.total)}. ${nameB} is ${formatCents(quoteB.total)}. That is a difference of ${formatCents(Math.abs(comparison.totals.difference))}.`,
  );

  if (comparison.verdict === "NOT_COMPARABLE") {
    const why = NOT_IDENTIFIABLE[comparison.attribution.reason ?? "NO_COMMON_SCOPE"];
    lines.push(`These are not two prices for the same job: ${why}. Comparing the totals would tell you nothing.`);
    return lines.map(assertSafeLanguage);
  }

  const percent = Math.round(comparison.coverage.overlap * 100);
  lines.push(
    `They overlap on ${comparison.coverage.shared} of ${comparison.coverage.shared + comparison.coverage.onlyA + comparison.coverage.onlyB} pieces of work, which is ${percent} per cent.`,
  );

  if (comparison.headline) {
    const present = comparison.headline.presentIn === "A" ? nameA : nameB;
    const absent = comparison.headline.presentIn === "A" ? nameB : nameA;
    const priced = comparison.headline.amountCents !== undefined ? `, priced at ${formatCents(comparison.headline.amountCents)}` : "";
    lines.push(
      `The largest difference is ${comparison.headline.label}: ${present} includes it${priced}, and ${absent} does not.`,
    );
  }

  const subsumed = comparison.alignments.find((a) => a.relation !== "EXACT");
  if (subsumed) {
    const bigger = subsumed.relation === "SUBSUMED_BY_A" ? nameA : nameB;
    lines.push(
      `On ${subsumed.label}, ${bigger} describes the larger job that contains what the other one describes, so those two lines are related rather than equivalent.`,
    );
  }

  if (comparison.attribution.identifiable) {
    const { scopeDifferenceCents = 0, rateDifferenceCents = 0, residualCents = 0 } = comparison.attribution;
    lines.push(
      `Of the ${formatCents(Math.abs(comparison.totals.difference))} gap, ${formatCents(Math.abs(scopeDifferenceCents))} is work one includes and the other does not, and ${formatCents(Math.abs(rateDifferenceCents))} is the same work at a different price.`,
    );
    if (Math.abs(residualCents) >= 100) {
      lines.push(
        `${formatCents(Math.abs(residualCents))} is not accounted for by either. That is the figure worth asking about.`,
      );
    } else {
      lines.push(`Nothing is left unaccounted for once those two are subtracted.`);
    }
  } else {
    const why = NOT_IDENTIFIABLE[comparison.attribution.reason ?? "LUMP_SUM"];
    lines.push(
      `I cannot tell you how much of the gap is the ${comparison.headline?.label ?? "difference in scope"} and how much is the price of the same work, because ${why}.`,
    );
    lines.push(
      `Asking for the same quote itemised, with a price against each line, is what would make that answerable.`,
    );
  }

  return lines.map(assertSafeLanguage);
}

/**
 * One short line for a screen that is being read from across a room.
 *
 * Alexa's display guidance is one title, one or two supporting fields and a next
 * action; this is the supporting field, and it is never the number on its own.
 */
export function comparisonHeadline(comparison: Comparison): string {
  if (comparison.verdict === "NOT_COMPARABLE") return "Not the same job";
  if (comparison.headline) return `${comparison.headline.label}: in one quote only`;
  if (comparison.attribution.identifiable && Math.abs(comparison.attribution.residualCents ?? 0) >= 100)
    return `${formatCents(Math.abs(comparison.attribution.residualCents!))} unaccounted for`;
  return "Same work, different price";
}
