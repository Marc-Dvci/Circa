import type { Comparison, Quote } from "#schema";
import { assertSafeLanguage, formatCents, sentenceCase } from "#schema";

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
    const reason = comparison.attribution.reason ?? "NO_COMMON_SCOPE";
    const why = NOT_IDENTIFIABLE[reason];
    // A lump sum is not a different job. Saying "these are not two prices for
    // the same job" about a quote whose own premise matched sent the customer
    // after the wrong remedy: the two may well describe the same roof, and the
    // reason nobody can tell is that one of them never wrote it down.
    lines.push(
      reason === "LUMP_SUM"
        ? `I cannot set these side by side, because ${why}. That is a property of the document, not of the roof.`
        : `These are not two prices for the same job: ${why}. Comparing the totals would tell you nothing.`,
    );
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
      const source = residualSource(comparison, quoteA, quoteB);
      lines.push(
        source
          ? `${formatCents(Math.abs(residualCents))} is not accounted for by either, and ${source}`
          : `${formatCents(Math.abs(residualCents))} is not accounted for by either. That is the figure worth asking about.`,
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
 * Where the unexplained money actually sits, when the comparison can say.
 *
 * "That is the figure worth asking about" is true and vague. The residual is a
 * subtraction, so most of the time it has a name: a priced line whose text
 * mapped to no work at all, or a line whose money covers both shared and
 * unshared work and does not say in what proportion. Naming it turns a question
 * the customer has to invent into one they can read off the quote.
 */
function residualSource(comparison: Comparison, quoteA: Quote, quoteB: Quote): string | null {
  const unclassified = Math.abs(comparison.attribution.unclassifiedCents ?? 0);
  const straddling = Math.abs(comparison.attribution.straddlingCents ?? 0);
  const residual = Math.abs(comparison.attribution.residualCents ?? 0);

  if (unclassified >= 100 && unclassified >= straddling) {
    const side = (comparison.attribution.unclassifiedCents ?? 0) > 0 ? quoteA : quoteB;
    const ids = (comparison.attribution.unclassifiedCents ?? 0) > 0 ? comparison.unmapped.a : comparison.unmapped.b;
    const items = side.lineItems.filter((li) => ids.includes(li.id) && typeof li.amount === "number");
    if (items.length === 1) {
      return `${unclassified === residual ? "all of it" : formatCents(unclassified)} sits on one line I could not classify: "${items[0]!.raw.trim()}". That is the line to ask about.`;
    }
    if (items.length > 1) {
      return `${formatCents(unclassified)} of that sits on ${items.length} lines I could not classify. Those are the lines to ask about.`;
    }
  }
  if (straddling >= 100) {
    return `${formatCents(straddling)} of that sits on lines covering both the work they share and work only one of them has, and neither quote says how it divides.`;
  }
  return null;
}

/**
 * One short line for a screen that is being read from across a room.
 *
 * Alexa's display guidance is one title, one or two supporting fields and a next
 * action; this is the supporting field, and it is never the number on its own.
 */
export function comparisonHeadline(comparison: Comparison): string {
  if (comparison.attribution.reason === "LUMP_SUM") return "One price for everything";
  if (comparison.verdict === "NOT_COMPARABLE") return "Not the same job";
  if (comparison.headline) return sentenceCase(`${comparison.headline.label}: in one quote only`);
  if (comparison.attribution.identifiable && Math.abs(comparison.attribution.residualCents ?? 0) >= 100)
    return `${formatCents(Math.abs(comparison.attribution.residualCents!))} unaccounted for`;
  return "Same work, different price";
}
