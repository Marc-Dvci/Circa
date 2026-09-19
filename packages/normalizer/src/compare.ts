import type {
  Alignment,
  AlignmentRelation,
  Attribution,
  Cents,
  Comparison,
  ComparisonVerdict,
  ComponentId,
  LineItem,
  NotIdentifiableReason,
  Quote,
  WorkAction,
} from "#schema";
import { actionsOverlap, computeItemisation } from "#schema";
import { component, covers, expand, labelFor } from "#taxonomy";

/**
 * Quote comparison.
 *
 * The product claim this file implements: **a price difference is not a finding
 * until the scopes are aligned, and it is not attributable at all unless both
 * documents put their money against the work they describe.** Most residential
 * quotes are one number for a paragraph, and for those the honest output is that
 * the gap cannot be decomposed — which this returns, by name, far more often
 * than it returns a residual.
 */

/** Below this Jaccard overlap the two documents are not describing the same job. */
export const MIN_OVERLAP = 0.25;
/** Each quote must attribute at least this share of its total to line items. */
export const MIN_ATTRIBUTION = 0.8;
/** Value share of unmapped line items above which the alignment is not trusted. */
export const MAX_UNMAPPED_SHARE = 0.1;

interface Side {
  quote: Quote;
  /** One entry per (component, action) the quote asserts, with the money attached to it. */
  units: Map<string, { component: ComponentId; action: WorkAction; lineItems: string[]; amount?: Cents }>;
  unmappedIds: string[];
  unmappedValue: Cents;
  attribution: number;
  lumpSum: boolean;
}

function key(componentId: ComponentId, action: WorkAction): string {
  return `${componentId}#${action}`;
}

/**
 * Money attaches to a line item, and a line item may assert several work units.
 * Splitting the amount evenly across them would invent a per-component price the
 * document does not contain, so the amount is recorded against every unit the
 * item asserts and de-duplicated by line item when summed. A line item is
 * counted once, whatever it covers.
 */
function buildSide(quote: Quote): Side {
  const units: Side["units"] = new Map();
  const unmappedIds: string[] = [];
  let unmappedValue = 0;

  for (const item of quote.lineItems) {
    // An alternate or add-on is priced outside the total and proposes nothing
    // until the customer picks it.
    if (item.kind === "OPTIONAL") continue;
    if (item.work.length === 0) {
      unmappedIds.push(item.id);
      unmappedValue += item.amount ?? 0;
      continue;
    }
    for (const unit of item.work) {
      const k = key(unit.component, unit.action);
      const existing = units.get(k);
      if (existing) {
        if (!existing.lineItems.includes(item.id)) existing.lineItems.push(item.id);
      } else {
        units.set(k, { component: unit.component, action: unit.action, lineItems: [item.id] });
      }
    }
  }

  const amountOf = (lineItemIds: readonly string[]): Cents | undefined => {
    const items = lineItemIds
      .map((id) => quote.lineItems.find((li) => li.id === id))
      .filter((li): li is LineItem => Boolean(li));
    if (items.length === 0 || items.some((li) => typeof li.amount !== "number")) return undefined;
    const seen = new Set<string>();
    let sum = 0;
    for (const li of items) {
      if (seen.has(li.id)) continue;
      seen.add(li.id);
      sum += li.amount!;
    }
    return sum;
  };

  for (const unit of units.values()) {
    const amount = amountOf(unit.lineItems);
    if (amount !== undefined) unit.amount = amount;
  }

  const itemisation = quote.itemisation ?? computeItemisation(quote);

  /**
   * A quote can attach one hundred per cent of its total to line items and
   * still be a lump sum.
   *
   * "Full roof replacement .......... $17,900" is a single priced line, so
   * `computeItemisation` reports perfect coverage — and the money is attached to
   * a container that expands into nine components, so nothing in the document
   * says what share belongs to the shingles. Coverage measures whether the money
   * is on named lines; this measures whether those lines name work at the
   * granularity a comparison needs. Both are required, and only one of them is
   * arithmetic.
   */
  const pricedItems = quote.lineItems.filter(
    (li) => typeof li.amount === "number" && li.work.length > 0 && li.kind !== "OPTIONAL",
  );
  const containerPriced =
    pricedItems.length > 0 &&
    pricedItems.every((li) => li.work.some((w) => (component(w.component)?.includes ?? []).length > 0));

  return {
    quote,
    units,
    unmappedIds,
    unmappedValue,
    attribution: itemisation.coverage,
    lumpSum: itemisation.level === "LUMP_SUM" || containerPriced,
  };
}

interface Pairing {
  a?: { component: ComponentId; action: WorkAction; lineItems: string[]; amount?: Cents };
  b?: { component: ComponentId; action: WorkAction; lineItems: string[]; amount?: Cents };
  relation: AlignmentRelation;
}

/**
 * Pair A's units with B's.
 *
 * Three passes, and the order matters.
 *
 * 1. Exact `(component, action)` pairs, so a subsumption never steals a partner
 *    an exact match wanted. Doing it in one greedy pass makes the result depend
 *    on line-item order, which is not a property the documents have.
 *
 * 2. **Container expansion.** A quote that says "full roof replacement" and a
 *    quote that says "replace eight shingles" are not unrelated, and they are
 *    not equivalent either. The container is expanded into the components it
 *    contains, so the comparison runs at the finest granularity *either*
 *    document supports: the shingles align, and the underlayment, drip edge and
 *    ridge vent the broader quote also covers show up as work only it includes.
 *    That is the honest reading, and it is why comparing those two totals is
 *    reported as a scope difference rather than a price difference.
 *
 * 3. Whatever is left is present in one quote only.
 */
function pair(a: Side, b: Side): Pairing[] {
  const out: Pairing[] = [];
  const usedA = new Set<string>();
  const usedB = new Set<string>();

  for (const [k, unitA] of a.units) {
    const unitB = b.units.get(k);
    if (!unitB) continue;
    usedA.add(k);
    usedB.add(k);
    out.push({ a: unitA, b: unitB, relation: "EXACT" });
  }

  // Expand a container on one side against the leaves on the other. Both
  // directions, and the wider side is recorded so the explanation can say which
  // quote described the larger job.
  const expandSide = (
    wide: Side,
    narrow: Side,
    usedWide: Set<string>,
    usedNarrow: Set<string>,
    wideIsA: boolean,
  ): void => {
    for (const [kw, unitWide] of wide.units) {
      if (usedWide.has(kw)) continue;
      const contained = expand(unitWide.component).filter((id) => id !== unitWide.component);
      if (contained.length === 0) continue;

      const matched: { leaf: ComponentId; narrowKey: string }[] = [];
      for (const [kn, unitNarrow] of narrow.units) {
        if (usedNarrow.has(kn)) continue;
        if (!actionsOverlap(unitWide.action, unitNarrow.action)) continue;
        if (!contained.includes(unitNarrow.component)) continue;
        matched.push({ leaf: unitNarrow.component, narrowKey: kn });
      }
      if (matched.length === 0) continue;

      usedWide.add(kw);
      const relation: AlignmentRelation = wideIsA ? "SUBSUMED_BY_A" : "SUBSUMED_BY_B";

      for (const { leaf, narrowKey } of matched) {
        usedNarrow.add(narrowKey);
        const unitNarrow = narrow.units.get(narrowKey)!;
        // The container carries no per-leaf price, so the wide side's entry is
        // deliberately amount-free. That is what makes the attribution
        // unidentifiable, which is the correct outcome: nobody knows what share
        // of a lump sum belongs to the shingles.
        const wideEntry = { component: leaf, action: unitWide.action, lineItems: unitWide.lineItems };
        out.push(
          wideIsA
            ? { a: wideEntry, b: unitNarrow, relation }
            : { a: unitNarrow, b: wideEntry, relation },
        );
      }

      // Everything the container covers that the other quote never mentioned.
      const alignedLeaves = new Set(matched.map((m) => m.leaf));
      for (const leaf of contained) {
        if (alignedLeaves.has(leaf)) continue;
        const entry = { component: leaf, action: unitWide.action, lineItems: unitWide.lineItems };
        out.push(wideIsA ? { a: entry, relation } : { b: entry, relation });
      }
    }
  };

  expandSide(a, b, usedA, usedB, true);
  expandSide(b, a, usedB, usedA, false);

  // Plain subsumption between two single components, neither of which expanded.
  for (const [ka, unitA] of a.units) {
    if (usedA.has(ka)) continue;
    for (const [kb, unitB] of b.units) {
      if (usedB.has(kb)) continue;
      if (!actionsOverlap(unitA.action, unitB.action)) continue;
      const aCoversB = covers(unitA.component, unitB.component);
      const bCoversA = covers(unitB.component, unitA.component);
      if (!aCoversB && !bCoversA) continue;
      usedA.add(ka);
      usedB.add(kb);
      out.push({ a: unitA, b: unitB, relation: aCoversB ? "SUBSUMED_BY_A" : "SUBSUMED_BY_B" });
      break;
    }
  }

  for (const [k, unitA] of a.units) if (!usedA.has(k)) out.push({ a: unitA, relation: "EXACT" });
  for (const [k, unitB] of b.units) if (!usedB.has(k)) out.push({ b: unitB, relation: "EXACT" });
  return out;
}

function isAncillary(id: ComponentId): boolean {
  return component(id)?.ancillary === true;
}

function isInspectionOnly(side: Side): boolean {
  const units = [...side.units.values()];
  if (units.length === 0) return false;
  return units.every((u) => u.action === "INSPECT" || u.component === "gen.inspection" || isAncillary(u.component));
}

/**
 * Split one quote's money by where the work it bought ended up.
 *
 * Money moves in line items, so the decomposition is computed over line items
 * and not over work units. A line item may assert several units — "replace 8
 * damaged shingles at the chimney" asserts shingles and chimney flashing — and
 * the document does not say how its money divides between them. Summing
 * `amountA - amountB` across the shared *units* therefore counted such a line
 * once per unit, and two quotes that both wrote that sentence reported a rate
 * difference twice the size of the one on the page.
 *
 * Each priced line item is classified once, by where the work it asserts landed:
 *
 * - `shared` — every unit it asserts aligned with the other quote. This is the
 *   same-work-different-price bucket.
 * - `only` — every unit it asserts is work the other quote never mentioned.
 *   This is the scope bucket.
 * - `straddling` — it covers both, and the document declined to say in what
 *   proportion. Left out of the other two on purpose, so its money falls into
 *   the residual instead of being assigned to a bucket it only half belongs to.
 */
function splitByLineItem(
  side: Side,
  alignments: readonly Alignment[],
  which: "A" | "B",
): { shared: Cents; only: Cents; straddling: Cents } {
  const sharedLines = new Set<string>();
  const onlyLines = new Set<string>();
  const onlyStatus = which === "A" ? "ONLY_A" : "ONLY_B";
  for (const alignment of alignments) {
    const ids = which === "A" ? alignment.lineItemsA : alignment.lineItemsB;
    if (alignment.status === "SHARED") for (const id of ids) sharedLines.add(id);
    else if (alignment.status === onlyStatus) for (const id of ids) onlyLines.add(id);
  }

  let shared = 0;
  let only = 0;
  let straddling = 0;
  for (const item of side.quote.lineItems) {
    if (typeof item.amount !== "number" || item.kind === "OPTIONAL") continue;
    const inShared = sharedLines.has(item.id);
    const inOnly = onlyLines.has(item.id);
    if (inShared && inOnly) straddling += item.amount;
    else if (inShared) shared += item.amount;
    else if (inOnly) only += item.amount;
  }
  return { shared, only, straddling };
}

export function compareQuotes(quoteA: Quote, quoteB: Quote, now = new Date().toISOString()): Comparison {
  const a = buildSide(quoteA);
  const b = buildSide(quoteB);
  const pairings = pair(a, b);

  const alignments: Alignment[] = pairings.map((p) => {
    const primary = p.a ?? p.b!;
    const status = p.a && p.b ? "SHARED" : p.a ? "ONLY_A" : "ONLY_B";
    const alignment: Alignment = {
      component: primary.component,
      action: primary.action,
      status,
      relation: p.relation,
      ancillary: isAncillary(primary.component),
      lineItemsA: p.a?.lineItems ?? [],
      lineItemsB: p.b?.lineItems ?? [],
      label: labelFor(primary.component),
    };
    if (p.a?.amount !== undefined) alignment.amountA = p.a.amount;
    if (p.b?.amount !== undefined) alignment.amountB = p.b.amount;
    return alignment;
  });

  const shared = alignments.filter((x) => x.status === "SHARED");
  const onlyA = alignments.filter((x) => x.status === "ONLY_A");
  const onlyB = alignments.filter((x) => x.status === "ONLY_B");
  /**
   * Overlap is computed over work the documents actually wrote.
   *
   * Expanding a container introduces one ONLY_A entry per component the wide
   * quote covers and the narrow one never mentioned, which is the right thing to
   * *report* — "this quote also covers the underlayment, the drip edge and the
   * ridge vent" is worth saying. Counting those in a Jaccard denominator is not:
   * a full roof replacement against eight shingles would score 2/10 and be
   * reported as two documents that barely describe the same job, when in fact one
   * contains the other exactly. The inflation is ours, so it comes back out here.
   */
  const derived = (x: Alignment): boolean => x.status !== "SHARED" && x.relation !== "EXACT";
  const writtenOnlyA = onlyA.filter((x) => !derived(x));
  const writtenOnlyB = onlyB.filter((x) => !derived(x));
  const denominator = shared.length + writtenOnlyA.length + writtenOnlyB.length;
  const overlap = denominator === 0 ? 0 : shared.length / denominator;

  const difference = quoteA.total - quoteB.total;

  // ── attribution ──────────────────────────────────────────────────────────
  const scopeItems = [...onlyA, ...onlyB];
  const pricedScope = scopeItems.every((x) => (x.status === "ONLY_A" ? x.amountA : x.amountB) !== undefined);
  const unmappedShareA = quoteA.total === 0 ? 0 : a.unmappedValue / quoteA.total;
  const unmappedShareB = quoteB.total === 0 ? 0 : b.unmappedValue / quoteB.total;

  /**
   * The order these are tested in is a product decision, not a formality.
   *
   * A lump sum is tested *before* low overlap, because a quote that is one
   * sentence and one number produces almost no work units, so its overlap with
   * an itemised quote is structurally low whatever the two documents describe.
   * Reporting NO_COMMON_SCOPE there would name a symptom the lump sum caused and
   * hand the customer the wrong remedy: "ask the assessor to price the same list"
   * instead of "ask for the first quote itemised". The second is the sentence
   * that makes the comparison answerable, and it is the only one of the two that
   * is true.
   *
   * `noCommonScope` is kept separately, because whether the totals can be
   * compared at all is a different question from why the gap cannot be split up.
   */
  const noCommonScope = overlap < MIN_OVERLAP;
  let reason: NotIdentifiableReason | undefined;
  if (isInspectionOnly(a) !== isInspectionOnly(b)) reason = "DIFFERENT_KIND_OF_WORK";
  else if (a.lumpSum || b.lumpSum) reason = "LUMP_SUM";
  else if (noCommonScope) reason = "NO_COMMON_SCOPE";
  else if (a.attribution < MIN_ATTRIBUTION || b.attribution < MIN_ATTRIBUTION || !pricedScope)
    reason = "INSUFFICIENT_ATTRIBUTION";
  else if (unmappedShareA > MAX_UNMAPPED_SHARE || unmappedShareB > MAX_UNMAPPED_SHARE) reason = "UNMAPPED_WORK";

  let attribution: Attribution;
  if (reason) {
    attribution = { identifiable: false, reason };
  } else {
    const splitA = splitByLineItem(a, alignments, "A");
    const splitB = splitByLineItem(b, alignments, "B");
    const scopeDifferenceCents = splitA.only - splitB.only;
    const rateDifferenceCents = splitA.shared - splitB.shared;
    attribution = {
      identifiable: true,
      scopeDifferenceCents,
      rateDifferenceCents,
      residualCents: difference - scopeDifferenceCents - rateDifferenceCents,
      straddlingCents: splitA.straddling - splitB.straddling,
      unclassifiedCents: a.unmappedValue - b.unmappedValue,
    };
  }

  // ── verdict ──────────────────────────────────────────────────────────────
  const substantiveScope = scopeItems.filter((x) => !x.ancillary);
  const subsumed = shared.some((x) => x.relation !== "EXACT");
  let verdict: ComparisonVerdict;
  if (reason === "DIFFERENT_KIND_OF_WORK" || noCommonScope) verdict = "NOT_COMPARABLE";
  else if (substantiveScope.length > 0 || subsumed) verdict = "SCOPE_DIFFERS";
  else verdict = "COMPARABLE";

  // ── headline ─────────────────────────────────────────────────────────────
  // Priced first, then concealed structural work, then anything substantive.
  // Concealed work outranks an unpriced surface item because "the other quote
  // says there is no damaged decking" is the sentence a homeowner needs.
  const rank = (x: Alignment): number => {
    const amount = x.status === "ONLY_A" ? x.amountA : x.amountB;
    if (amount !== undefined) return 1_000_000_000 + amount;
    if (component(x.component)?.concealed) return 1_000_000;
    return 1;
  };
  const best = [...substantiveScope].sort((x, y) => rank(y) - rank(x))[0];

  const comparison: Comparison = {
    caseId: quoteA.caseId,
    quoteAId: quoteA.id,
    quoteBId: quoteB.id,
    verdict,
    alignments,
    coverage: { shared: shared.length, onlyA: onlyA.length, onlyB: onlyB.length, overlap },
    totals: { a: quoteA.total, b: quoteB.total, difference },
    attribution,
    unmapped: { a: a.unmappedIds, b: b.unmappedIds },
    generatedAt: now,
  };
  if (best) {
    const amount = best.status === "ONLY_A" ? best.amountA : best.amountB;
    comparison.headline = {
      component: best.component,
      label: best.label,
      presentIn: best.status === "ONLY_A" ? "A" : "B",
      ...(amount !== undefined ? { amountCents: amount } : {}),
    };
  }
  return comparison;
}
