import { describe, expect, it } from "vitest";
import { apportion, computeItemisation, formatCents, parseCents, workKey, type Quote } from "#schema";
import { AMBIGUOUS_PHRASES, TAXONOMY_STATS, covers, findAction, normaliseText } from "#taxonomy";
import { compareQuotes, normaliseLineItem, parseQuoteText, quoteFromSpokenOffer } from "#normalizer";

describe("money", () => {
  it("parses the forms a quote actually uses", () => {
    expect(parseCents("$6,500")).toBe(650_000);
    expect(parseCents("6500.00")).toBe(650_000);
    expect(parseCents("$1,850.50")).toBe(185_050);
    expect(parseCents("Total: $95")).toBe(9_500);
    expect(parseCents("no number here")).toBeNull();
  });

  it("formats whole dollars without decimals", () => {
    expect(formatCents(650_000)).toBe("$6,500");
    expect(formatCents(185_050)).toBe("$1,850.50");
    expect(formatCents(-40_300)).toBe("-$403");
  });

  it("apportions without losing or inventing a cent", () => {
    for (const weights of [[1, 1, 1], [3, 1], [7, 11, 13, 2], [1]]) {
      const parts = apportion(100_001, weights);
      expect(parts.reduce((a, b) => a + b, 0)).toBe(100_001);
      expect(parts.every(Number.isSafeInteger)).toBe(true);
    }
  });
});

describe("taxonomy", () => {
  it("is big enough to be a vocabulary rather than a demo prop", () => {
    expect(TAXONOMY_STATS.components).toBeGreaterThan(80);
    expect(TAXONOMY_STATS.lexicalForms).toBeGreaterThan(300);
  });

  it("knows which phrases it cannot resolve on its own", () => {
    // "coil" is claimed by the evaporator coil and nothing else in HVAC, but
    // "panel" and "flange" are genuinely contested. The point is that the set is
    // non-empty and enumerable rather than discovered in production.
    expect(AMBIGUOUS_PHRASES.size).toBeGreaterThan(0);
  });

  it("subsumes the parts of a whole-roof replacement", () => {
    expect(covers("roof.full_replacement", "roof.shingles")).toBe(true);
    expect(covers("roof.full_replacement", "gen.disposal")).toBe(true);
    expect(covers("roof.full_replacement", "roof.decking")).toBe(false);
    expect(covers("roof.shingles", "roof.full_replacement")).toBe(false);
  });

  it("prefers the longest action phrase", () => {
    expect(findAction(normaliseText("tear off and replace the roof"))?.action).toBe("REPLACE");
    expect(findAction(normaliseText("inspect the flashing"))?.action).toBe("INSPECT");
  });
});

describe("line items", () => {
  it("maps two very different sentences to the same work", () => {
    const a = normaliseLineItem("Repair chimney area", "roofing");
    const b = normaliseLineItem(
      "Remove existing step flashing and counter flashing; install new aluminium flashing and seal penetrations",
      "roofing",
    );
    const keyA = a.work.map(workKey);
    const keyB = b.work.map(workKey);
    expect(keyA.some((k) => k.startsWith("roof.chimney_flashing"))).toBe(true);
    expect(keyB.some((k) => k.startsWith("roof.chimney_flashing"))).toBe(true);
  });

  it("suppresses a shorter lexeme inside a longer one", () => {
    const item = normaliseLineItem("replace the chimney flashing", "roofing");
    // "chimney flashing", not "chimney" and "flashing" as two components.
    expect(item.work.map((w) => w.component)).toEqual(["roof.chimney_flashing"]);
  });

  it("reads a negated component as an exclusion, not as work", () => {
    const item = normaliseLineItem("Replace 8 shingles; no decking replacement observed", "roofing");
    expect(item.work.map((w) => w.component)).toContain("roof.shingles");
    expect(item.work.map((w) => w.component)).not.toContain("roof.decking");
    expect(item.excluded).toContain("roof.decking");
  });

  it("treats conditional work as not included", () => {
    const item = normaliseLineItem("Replace roof decking if required at $65 per sheet", "roofing");
    expect(item.work.map((w) => w.component)).not.toContain("roof.decking");
    expect(item.excluded).toContain("roof.decking");
  });

  it("reads a quantity from the words immediately before the component", () => {
    const item = normaliseLineItem("Replace approximately 60 square feet of roof decking", "roofing");
    const decking = item.work.find((w) => w.component === "roof.decking");
    expect(decking?.quantity).toBe(60);
    expect(decking?.unit).toBe("sq_ft");
  });

  it("does not read a price as a quantity", () => {
    const item = normaliseLineItem("Chimney flashing 2200 dollars", "roofing");
    expect(item.work.find((w) => w.component === "roof.chimney_flashing")?.quantity).toBeUndefined();
  });

  it("declines to map text with no component in it", () => {
    const item = normaliseLineItem("Thank you for the opportunity to quote this project", "roofing");
    expect(item.work).toEqual([]);
    expect(item.unmapped).toBe(true);
  });

  it("drops a phrase two trades claim rather than guessing", () => {
    const unknownTrade = normaliseLineItem("replace the panel", "unknown");
    expect(unknownTrade.work.map((w) => w.component)).not.toContain("elec.panel");
    expect(unknownTrade.ambiguous.length + unknownTrade.work.length).toBeGreaterThan(0);
    const electrical = normaliseLineItem("replace the panel", "electrical");
    expect(electrical.work.map((w) => w.component)).toContain("elec.panel");
  });
});

describe("quote parsing", () => {
  const text = `
Prepared by: Henderson Roofing
Remove and replace chimney step flashing and counter flashing ........ $850.00
Replace 8 damaged asphalt shingles ................................... $320.00
Seal roof penetrations ............................................... $180.00
Labour, 6 hours ...................................................... $480.00
Disposal fee ......................................................... $ 20.00
Exclusions: roof decking replacement; gutter work
Warranty: 2 years on workmanship
Completion: within 5 working days
Total: $1,850.00
`;

  it("reads line items, amounts and exclusions", () => {
    const quote = parseQuoteText({ id: "q1", caseId: "c1", text, trade: "roofing", source: "SECOND_OPINION" });
    expect(quote.total).toBe(185_000);
    expect(quote.lineItems.length).toBe(5);
    expect(quote.warranty).toBe("2 years on workmanship");
    expect(quote.completionDate).toBe("within 5 working days");
    expect(quote.exclusions.some((e) => /decking/i.test(e))).toBe(true);
  });

  it("computes itemisation from what the document attributes", () => {
    const quote = parseQuoteText({ id: "q1", caseId: "c1", text, trade: "roofing", source: "SECOND_OPINION" });
    expect(quote.itemisation?.level).toBe("ITEMISED");
    expect(quote.itemisation?.coverage).toBeCloseTo(1, 5);
  });

  it("reads a spoken offer as a lump sum, because it is one", () => {
    const quote = quoteFromSpokenOffer({
      id: "q0",
      caseId: "c1",
      description: "replace the flashing around the chimney and some shingles, maybe the decking underneath",
      total: 650_000,
      trade: "roofing",
    });
    expect(quote.itemisation?.level).toBe("LUMP_SUM");
    expect(quote.itemisation?.coverage).toBe(0);
  });
});

describe("comparison", () => {
  const lumpSum = quoteFromSpokenOffer({
    id: "qA",
    caseId: "c1",
    contractorName: "the first quote",
    description:
      "Replace the chimney flashing, replace shingles around it and replace the roof decking underneath",
    total: 650_000,
    trade: "roofing",
  });

  const itemised = parseQuoteText({
    id: "qB",
    caseId: "c1",
    contractorName: "Henderson Roofing",
    source: "SECOND_OPINION",
    trade: "roofing",
    text: `
Replace chimney step and counter flashing ...... $850.00
Replace 8 asphalt shingles ..................... $320.00
Seal roof penetrations ......................... $180.00
Disposal fee ................................... $500.00
Total: $1,850.00
`,
  });

  it("refuses to attribute a gap when one side is a single number", () => {
    const result = compareQuotes(lumpSum, itemised);
    expect(result.attribution.identifiable).toBe(false);
    expect(result.attribution.reason).toBe("LUMP_SUM");
    expect(result.attribution.residualCents).toBeUndefined();
  });

  it("still names the scope difference the documents do support", () => {
    const result = compareQuotes(lumpSum, itemised);
    expect(result.verdict).toBe("SCOPE_DIFFERS");
    expect(result.headline?.component).toBe("roof.decking");
    expect(result.headline?.presentIn).toBe("A");
  });

  it("decomposes the gap when both sides attribute their money", () => {
    const a = parseQuoteText({
      id: "qC",
      caseId: "c1",
      source: "CONTRACTOR",
      trade: "roofing",
      text: `
Replace chimney step and counter flashing ...... $1,100.00
Replace 8 asphalt shingles ..................... $  400.00
Replace 60 sq ft roof decking .................. $2,200.00
Seal roof penetrations ......................... $  180.00
Disposal fee ................................... $  520.00
Total: $4,400.00
`,
    });
    const result = compareQuotes(a, itemised);
    expect(result.attribution.identifiable).toBe(true);
    // Decking is in A only, at $2,200.
    expect(result.attribution.scopeDifferenceCents).toBe(220_000);
    // Flashing 1100 vs 850, shingles 400 vs 320, seal 180 vs 180, disposal 520 vs 500.
    expect(result.attribution.rateDifferenceCents).toBe(25_000 + 8_000 + 0 + 2_000);
    // Totals differ by 4400 - 1850 = 2550; scope 2200 + rate 350 accounts for all of it.
    expect(result.totals.difference).toBe(255_000);
    expect(result.attribution.residualCents).toBe(0);
  });

  it("counts a line that asserts two components once, not once per component", () => {
    // The document prices one line. It does not say how that price divides
    // between the two things the line names, so the comparison must not divide
    // it, and it must not count it twice either. Both quotes write the same
    // sentence at a different price: the honest rate difference is $200, the
    // difference on the page, not $400.
    const side = (flashing: string, ridge: string, total: string): Quote =>
      parseQuoteText({
        id: `q_${total}`,
        caseId: "c1",
        source: "CONTRACTOR",
        trade: "roofing",
        text: `Replace chimney flashing and the ridge vent ... ${flashing}\nDisposal fee .................................. ${ridge}\nTotal: ${total}\n`,
      });
    const dear = side("$1,200.00", "$300.00", "$1,500.00");
    const cheap = side("$1,000.00", "$300.00", "$1,300.00");

    // One line, two work units, on both sides.
    expect(dear.lineItems[0]!.work.map((w) => w.component).sort()).toEqual(["roof.chimney_flashing", "roof.ridge_vent"]);

    const result = compareQuotes(dear, cheap);
    expect(result.attribution.identifiable).toBe(true);
    expect(result.attribution.rateDifferenceCents).toBe(20_000);
    expect(result.attribution.residualCents).toBe(0);
  });

  it("leaves money on a line that covers both shared and unshared work out of both buckets", () => {
    // A line whose money buys work the other quote has and work it does not, with
    // no split stated. Neither bucket can claim it, so it falls into the residual
    // and the residual says where it came from.
    const a = parseQuoteText({
      id: "qE",
      caseId: "c1",
      source: "CONTRACTOR",
      trade: "roofing",
      text: `Replace chimney flashing and 60 sq ft of roof decking ... $3,000.00\nReplace 8 asphalt shingles ............................. $  320.00\nSeal roof penetrations ................................. $  180.00\nDisposal fee ........................................... $  500.00\nTotal: $4,000.00\n`,
    });
    const result = compareQuotes(a, itemised);
    expect(result.attribution.identifiable).toBe(true);
    // Nothing is only-A on a line of its own, so there is no scope difference to
    // name, and the $3,000 line is in neither bucket.
    expect(result.attribution.straddlingCents).toBe(300_000);
    expect(result.attribution.scopeDifferenceCents).toBe(0);
    expect(result.attribution.residualCents).toBe(result.totals.difference - (result.attribution.rateDifferenceCents ?? 0));
  });

  it("reports a residual when the totals do not add up to the line items", () => {
    const inflated = parseQuoteText({
      id: "qD",
      caseId: "c1",
      source: "CONTRACTOR",
      trade: "roofing",
      text: `
Replace chimney step and counter flashing ...... $850.00
Replace 8 asphalt shingles ..................... $320.00
Seal roof penetrations ......................... $180.00
Disposal fee ................................... $500.00
Total: $1,850.00
`,
    });
    // Same document, but the stated total is higher than the sum of its parts.
    inflated.total = 250_000;
    inflated.itemisation = computeItemisation(inflated);
    const result = compareQuotes(inflated, itemised);
    // Coverage is now 1850/2500 = 74%, below the attribution floor.
    expect(result.attribution.identifiable).toBe(false);
    expect(result.attribution.reason).toBe("INSUFFICIENT_ATTRIBUTION");
  });

  it("does not compare an inspection with a repair", () => {
    const assessment = parseQuoteText({
      id: "qE",
      caseId: "c1",
      source: "SECOND_OPINION",
      trade: "roofing",
      text: `Roof inspection and written assessment ........ $95.00\nTotal: $95.00`,
    });
    const result = compareQuotes(itemised, assessment);
    expect(result.verdict).toBe("NOT_COMPARABLE");
    expect(result.attribution.reason).toBe("DIFFERENT_KIND_OF_WORK");
  });

  it("says a whole-roof quote contains an eight-shingle quote rather than matching it", () => {
    const whole = quoteFromSpokenOffer({
      id: "qF",
      caseId: "c1",
      description: "full roof replacement",
      total: 1_800_000,
      trade: "roofing",
    });
    const result = compareQuotes(whole, itemised);
    const shingles = result.alignments.find((x) => x.component === "roof.shingles");
    expect(shingles?.status).toBe("SHARED");
    expect(shingles?.relation).toBe("SUBSUMED_BY_A");
  });
});
