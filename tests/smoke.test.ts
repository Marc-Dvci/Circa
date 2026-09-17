import { describe, expect, it } from "vitest";
import { MemoryCaseRepository, CaseService, DynamoCaseRepository, DynamoTableDouble, VersionConflictError } from "#store";
import { agenda, runVerification, summarise } from "#verification";
import { findAnchoring } from "#normalizer";
import { findUnsafeLanguage, UnsafeLanguageError, assertSafeLanguage } from "#schema";
import { canTransition, reachableStates } from "#domain";

/**
 * A first pass over the layers above the normaliser.
 *
 * Deliberately thin: it proves the service, the rule engine, the state machine
 * and the DynamoDB double are wired to each other and to the real engines, not
 * that the rules are right. Rule correctness is the corpus's job, and the corpus
 * is not built yet.
 */

const MARGARET = {
  userId: "user_demo",
  issueSummary: "A roofer says the chimney flashing has failed and water could get in tonight",
  trade: "roofing" as const,
};

async function openCase(): Promise<CaseService> {
  return new CaseService(new MemoryCaseRepository());
}

describe("case service", () => {
  it("captures a spoken offer as a lump-sum quote and runs the checklist", async () => {
    const service = await openCase();
    const repair = await service.startCase(MARGARET);
    const { offer, quote, report } = await service.captureOffer({
      caseId: repair.id,
      description:
        "They said the flashing around the chimney has failed and the shingles near it need replacing, and maybe the decking underneath",
      companyName: "Apex Exteriors",
      quotedPrice: 650_000,
      depositRequested: 300_000,
      context: {
        contractorFoundBy: "DOOR_KNOCK",
        decisionRequestedBy: "TODAY",
        urgencyClaim: "water could get in tonight",
        damageShownToCustomer: false,
        writtenScopeProvided: false,
        paymentMethodsRequested: ["CASH"],
      },
    });

    expect(offer.id).toMatch(/^offer_/);
    expect(quote?.itemisation?.level).toBe("LUMP_SUM");

    const attention = report.checks.filter((c) => c.status === "ATTENTION").map((c) => c.ruleId);
    expect(attention).toContain("conditions.unsolicited");
    expect(attention).toContain("conditions.immediate_decision");
    expect(attention).toContain("conditions.deposit_share");
    expect(attention).toContain("conditions.payment_method");

    // The opening sentence denies a trust verdict rather than issuing one.
    expect(summarise(report)).toMatch(/can't tell you whether this contractor is trustworthy/i);
    expect(agenda(report).length).toBeGreaterThan(0);
  });

  it("does not raise a single ATTENTION on an ordinary job", async () => {
    const service = await openCase();
    const repair = await service.startCase({
      userId: "user_demo",
      issueSummary: "The water heater is leaking and needs replacing",
      trade: "plumbing",
    });
    const { report } = await service.captureOffer({
      caseId: repair.id,
      description: "Replace the water heater and the expansion tank",
      companyName: "Northside Plumbing",
      quotedPrice: 210_000,
      depositRequested: 40_000,
      context: {
        contractorFoundBy: "REFERRAL",
        decisionRequestedBy: "THIS_WEEK",
        damageShownToCustomer: true,
        writtenScopeProvided: true,
        licenceNumberProvided: true,
        paymentMethodsRequested: ["CARD", "CHECK"],
      },
    });
    expect(report.counts.attention).toBe(0);
  });

  it("keeps the baseline and measures a later change against it", async () => {
    const service = await openCase();
    const repair = await service.startCase(MARGARET);
    await service.captureOffer({
      caseId: repair.id,
      description: "Replace the chimney flashing and eight shingles",
      companyName: "Apex Exteriors",
      quotedPrice: 185_000,
    });
    const quote = await service.addQuote({
      caseId: repair.id,
      source: "CONTRACTOR",
      contractorName: "Apex Exteriors",
      text: `
Replace chimney step and counter flashing ...... $850.00
Replace 8 asphalt shingles ..................... $400.00
Seal roof penetrations ......................... $180.00
Disposal fee ................................... $420.00
Total: $1,850.00
`,
    });
    await service.acceptScope({ caseId: repair.id, quoteId: quote.id });
    await service.startWork(repair.id);

    const { review } = await service.recordScopeChange({
      caseId: repair.id,
      describedAs: "Replace 60 square feet of roof decking found under the flashing",
      amountCents: 220_000,
    });

    expect(review.verdict).toBe("OUTSIDE_BASELINE");
    expect(review.newWork.map((w) => w.component)).toContain("roof.decking");
    expect(review.increaseFraction).toBeCloseTo(220_000 / 185_000, 5);
    const finding = review.checks.find((c) => c.ruleId === "change.outside_baseline");
    expect(finding?.status).toBe("ATTENTION");
    expect(finding?.statement).toMatch(/proposed change, not as approved work/i);

    // The baseline is written once. Accepting a second scope on the same case
    // would make the review above meaningless.
    await expect(service.acceptScope({ caseId: repair.id, quoteId: quote.id })).rejects.toThrow(
      /already accepted a scope/,
    );
  });

  it("says a change is already covered when the baseline covers it", async () => {
    const service = await openCase();
    const repair = await service.startCase(MARGARET);
    await service.captureOffer({ caseId: repair.id, description: "Full roof replacement", quotedPrice: 1_800_000 });
    const quote = await service.addQuote({
      caseId: repair.id,
      source: "CONTRACTOR",
      text: `Full roof replacement, tear off and replace ....... $18,000.00\nTotal: $18,000.00`,
    });
    await service.acceptScope({ caseId: repair.id, quoteId: quote.id });
    await service.startWork(repair.id);
    const { review } = await service.recordScopeChange({
      caseId: repair.id,
      describedAs: "Replace the ridge vent",
      amountCents: 40_000,
    });
    expect(review.verdict).toBe("WITHIN_BASELINE");
  });

  it("keeps the neutral scope free of the first opinion's price and remedy", async () => {
    const service = await openCase();
    const repair = await service.startCase(MARGARET);
    const { offer } = await service.captureOffer({
      caseId: repair.id,
      description: "Replace the chimney flashing and the shingles around it",
      companyName: "Apex Exteriors",
      quotedPrice: 650_000,
      context: { urgencyClaim: "water could get in tonight" },
    });
    const scope = await service.structureScope(repair.id);
    expect(findAnchoring(scope, offer)).toEqual([]);
    expect(scope.withheld.map((w) => w.what).join(" ")).toMatch(/Apex Exteriors/);
    expect(scope.inspect).toContain("roof.decking");
  });

  it("deletes a case completely when asked", async () => {
    const service = await openCase();
    const repair = await service.startCase(MARGARET);
    expect(await service.deleteCase(repair.id)).toBe(true);
    expect(await service.snapshot(repair.id)).toBeUndefined();
  });
});

describe("state machine", () => {
  it("reaches every declared state from NEW", () => {
    const reachable = reachableStates();
    expect(reachable.size).toBe(11);
  });

  it("refuses to un-accept a decision", () => {
    expect(canTransition("DECISION_RECORDED", "OFFER_CAPTURED")).toBe(false);
    expect(canTransition("CLOSED", "VERIFYING")).toBe(false);
  });
});

describe("safe language", () => {
  it("catches the sentences the product must never say", () => {
    expect(findUnsafeLanguage("This contractor is a scammer")).not.toBeNull();
    expect(findUnsafeLanguage("They're trying to take your money")).not.toBeNull();
    expect(findUnsafeLanguage("This should cost $1,800")).not.toBeNull();
    expect(findUnsafeLanguage("the fair market price is $2,000")).not.toBeNull();
    expect(() => assertSafeLanguage("They are probably unlicensed")).toThrow(UnsafeLanguageError);
  });

  it("allows the one sentence that denies a trust verdict", () => {
    expect(findUnsafeLanguage("I can't tell you whether this contractor is trustworthy.")).toBeNull();
  });

  it("passes the ordinary product sentences", () => {
    expect(findUnsafeLanguage("The licence has not been checked against a register.")).toBeNull();
    expect(findUnsafeLanguage("Two comparable assessments fall between $1,750 and $2,450.")).toBeNull();
  });
});

describe("dynamodb adapter", () => {
  const seed = () => {
    const double = new DynamoTableDouble();
    return { double, repo: new DynamoCaseRepository(double, "circa-cases") };
  };

  it("round-trips a case through the double", async () => {
    const { repo } = seed();
    const service = new CaseService(repo);
    const repair = await service.startCase(MARGARET);
    expect((await service.snapshot(repair.id))?.case.id).toBe(repair.id);
    expect(await repo.listByUser("user_demo")).toHaveLength(1);
    expect(await repo.delete(repair.id)).toBe(true);
    expect(await repo.delete(repair.id)).toBe(false);
  });

  it("rejects a write against a stale version", async () => {
    const { repo } = seed();
    const service = new CaseService(repo);
    const repair = await service.startCase(MARGARET);
    const stale = (await repo.get(repair.id))!;
    await repo.put({ ...stale });
    await expect(repo.put({ ...stale })).rejects.toBeInstanceOf(VersionConflictError);
  });

  it("refuses to create the same case twice", async () => {
    const { repo } = seed();
    const service = new CaseService(repo);
    const repair = await service.startCase(MARGARET);
    const record = (await repo.get(repair.id))!;
    await expect(repo.create(record)).rejects.toThrow(/already exists/);
  });
});
