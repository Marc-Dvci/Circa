import { CaseService, MemoryCaseRepository } from "#store";
import { runVerification } from "#verification";
import { compareQuotes, findAnchoring, parseQuoteText, quoteFromSpokenOffer } from "#normalizer";
import { assertSafeLanguage, findUnsafeLanguage, type Quote, type Trade } from "#schema";
import { isolate, renderForModel, scanForInjection, type InjectionCategory } from "#documents";
import { presentComparison, presentVerification } from "#agent";
import {
  loadInjectionDocuments,
  loadQuotePairs,
  loadScenarios,
  type QuotePair,
  type QuoteSide,
  type Scenario,
} from "./corpora.js";

/**
 * Scoring the three corpora.
 *
 * The metrics are chosen so that the lazy way to win each one loses another. A
 * checklist that raises everything gets perfect recall on the conditions and
 * fails the false-alarm rate; a comparison engine that always produces a number
 * gets perfect coverage and fails every refusal; an injection filter that flags
 * any document containing the word "instructions" catches all sixteen attacks
 * and fires on the controls. Reporting them together is the only way any of them
 * means anything.
 */

export interface ScenarioResult {
  id: string;
  title: string;
  kind: Scenario["kind"];
  expected: string[];
  actual: string[];
  /** Fired without being expected. On an ORDINARY scenario this is a false alarm. */
  spurious: string[];
  missed: string[];
  pass: boolean;
  /** Every check statement, run through the language guard. */
  languageProblems: string[];
  checksTotal: number;
  scopeLeaks: string[];
}

export interface ScenarioReport {
  results: ScenarioResult[];
  total: number;
  ordinary: number;
  conditionsPresent: number;
  passed: number;
  /** ATTENTION firings that were expected / all ATTENTION firings. */
  attentionPrecision: number;
  attentionRecall: number;
  /** Ordinary scenarios with at least one ATTENTION / all ordinary scenarios. */
  falseAlarmRate: number;
  languageFailures: number;
  scopeLeakFailures: number;
  /**
   * Rules that were seen citing published guidance by URL, and rules that were
   * seen citing only CIRCA's own policy, across all 48 scenarios.
   *
   * "Eighteen checks that cite published FTC guidance" is a sentence in the
   * narration, the README and the store listing, and it was wrong by two. The
   * number is counted here rather than remembered, from the bases the rules
   * actually emitted, so labelling a rule as ours moves it.
   */
  rulesCitingGuidance: number;
  rulesCitingPolicy: number;
}

export async function evaluateScenarios(): Promise<ScenarioReport> {
  const scenarios = await loadScenarios();
  /** ruleId to every basis source it was seen emitting. NOT_APPLICABLE is excluded: it carries a placeholder basis. */
  const basisSources = new Map<string, Set<string>>();
  const results: ScenarioResult[] = [];

  for (const scenario of scenarios) {
    const service = new CaseService(new MemoryCaseRepository());
    const repair = await service.startCase({
      userId: "eval",
      issueSummary: scenario.issueSummary,
      trade: scenario.trade,
    });
    await service.captureOffer({
      caseId: repair.id,
      description: scenario.offer.description,
      ...(scenario.offer.companyName ? { companyName: scenario.offer.companyName } : {}),
      ...(scenario.offer.contractorName ? { contractorName: scenario.offer.contractorName } : {}),
      ...(scenario.offer.quotedPrice !== undefined ? { quotedPrice: Math.round(scenario.offer.quotedPrice * 100) } : {}),
      ...(scenario.offer.depositRequested !== undefined
        ? { depositRequested: Math.round(scenario.offer.depositRequested * 100) }
        : {}),
      context: scenario.offer.context ?? {},
    });
    if (scenario.answers) {
      await service.answerVerification({ caseId: repair.id, answers: scenario.answers });
    }

    const snapshot = (await service.snapshot(repair.id))!;
    const report = runVerification(snapshot);
    for (const check of report.checks) {
      if (check.status === "NOT_APPLICABLE") continue;
      (basisSources.get(check.ruleId) ?? basisSources.set(check.ruleId, new Set()).get(check.ruleId)!).add(
        check.basis.source,
      );
    }
    const actual = report.checks.filter((c) => c.status === "ATTENTION").map((c) => c.ruleId).sort();
    const expected = [...scenario.expectAttention].sort();
    const spurious = actual.filter((id) => !expected.includes(id));
    const missed = expected.filter((id) => !actual.includes(id));

    // Every sentence the product would say on this scenario, through the guard.
    const languageProblems: string[] = [];
    const payload = presentVerification(snapshot, report);
    for (const text of [payload.speech, ...report.checks.map((c) => c.statement), ...report.checks.map((c) => c.nextStep ?? "")]) {
      if (!text) continue;
      const hit = findUnsafeLanguage(text);
      if (hit) languageProblems.push(`${hit.why}: "${hit.matched}"`);
    }

    // The neutral scope is generated for every scenario, not only the demo, and
    // checked for leaks. A guard that only runs on one case is a guard that has
    // been tested once.
    const scope = await service.structureScope(repair.id);
    const scopeLeaks = findAnchoring(scope, snapshot.offers.at(-1)!);

    results.push({
      id: scenario.id,
      title: scenario.title,
      kind: scenario.kind,
      expected,
      actual,
      spurious,
      missed,
      pass: spurious.length === 0 && missed.length === 0 && languageProblems.length === 0 && scopeLeaks.length === 0,
      languageProblems,
      checksTotal: report.checks.length,
      scopeLeaks,
    });
  }

  const seen = [...basisSources.values()];
  const citingGuidance = seen.filter((sources) => [...sources].some((s) => s !== "CIRCA_POLICY")).length;

  const ordinary = results.filter((r) => r.kind === "ORDINARY");
  const firings = results.reduce((sum, r) => sum + r.actual.length, 0);
  const correctFirings = results.reduce((sum, r) => sum + r.actual.filter((id) => r.expected.includes(id)).length, 0);
  const expectedFirings = results.reduce((sum, r) => sum + r.expected.length, 0);

  return {
    results,
    total: results.length,
    ordinary: ordinary.length,
    conditionsPresent: results.length - ordinary.length,
    passed: results.filter((r) => r.pass).length,
    attentionPrecision: firings === 0 ? 1 : correctFirings / firings,
    attentionRecall: expectedFirings === 0 ? 1 : correctFirings / expectedFirings,
    falseAlarmRate: ordinary.length === 0 ? 0 : ordinary.filter((r) => r.actual.length > 0).length / ordinary.length,
    languageFailures: results.filter((r) => r.languageProblems.length > 0).length,
    scopeLeakFailures: results.filter((r) => r.scopeLeaks.length > 0).length,
    rulesCitingGuidance: citingGuidance,
    rulesCitingPolicy: seen.length - citingGuidance,
  };
}

// ── quote pairs ─────────────────────────────────────────────────────────────

export interface QuotePairResult {
  id: string;
  title: string;
  verdict: string;
  expectedVerdict: string;
  identifiable: boolean;
  expectedIdentifiable: boolean;
  reason: string | null;
  expectedReason: string | null;
  alignmentErrors: string[];
  pass: boolean;
}

export interface QuoteReport {
  results: QuotePairResult[];
  total: number;
  passed: number;
  verdictAccuracy: number;
  /** Pairs where the engine correctly declined to attribute / pairs where it should have. */
  refusalRecall: number;
  refusalPrecision: number;
  /** Component-level: correct alignment placements / all asserted placements. */
  alignmentAccuracy: number;
  refusalsExpected: number;
}

function buildQuote(side: QuoteSide, id: string, trade: Trade): Quote {
  if (side.spoken) {
    return quoteFromSpokenOffer({
      id,
      caseId: "case_eval",
      description: side.spoken.description,
      total: Math.round(side.spoken.total * 100),
      trade,
      ...(side.contractorName ? { contractorName: side.contractorName } : {}),
      capturedAt: "2026-09-01T00:00:00.000Z",
    });
  }
  return parseQuoteText({
    id,
    caseId: "case_eval",
    text: side.text ?? "",
    trade,
    source: id === "quote_a" ? "CONTRACTOR" : "SECOND_OPINION",
    defaultAction: "REPLACE",
    ...(side.contractorName ? { contractorName: side.contractorName } : {}),
    capturedAt: "2026-09-01T00:00:00.000Z",
  });
}

export async function evaluateQuotePairs(): Promise<QuoteReport> {
  const pairs = await loadQuotePairs();
  const results: QuotePairResult[] = [];
  let placements = 0;
  let correctPlacements = 0;

  for (const pair of pairs) {
    const quoteA = buildQuote(pair.a, "quote_a", pair.trade);
    const quoteB = buildQuote(pair.b, "quote_b", pair.trade);
    const comparison = compareQuotes(quoteA, quoteB, "2026-09-01T00:00:00.000Z");

    const alignmentErrors: string[] = [];
    const statusOf = (component: string): string | undefined =>
      comparison.alignments.find((a) => a.component === component)?.status;

    for (const [expectedStatus, list] of [
      ["SHARED", pair.expect.sharedComponents ?? []],
      ["ONLY_A", pair.expect.onlyAComponents ?? []],
      ["ONLY_B", pair.expect.onlyBComponents ?? []],
    ] as const) {
      for (const component of list) {
        placements += 1;
        const actual = statusOf(component);
        if (actual === expectedStatus) correctPlacements += 1;
        else alignmentErrors.push(`${component}: expected ${expectedStatus}, got ${actual ?? "absent"}`);
      }
    }
    for (const component of pair.expect.notAlignedComponents ?? []) {
      placements += 1;
      const actual = statusOf(component);
      if (actual === undefined) correctPlacements += 1;
      else alignmentErrors.push(`${component}: expected absent, got ${actual}`);
    }
    for (const [field, expected] of [
      ["scopeDifferenceCents", pair.expect.scopeDifferenceCents],
      ["rateDifferenceCents", pair.expect.rateDifferenceCents],
      ["residualCents", pair.expect.residualCents],
    ] as const) {
      if (expected === undefined) continue;
      placements += 1;
      const actual = comparison.attribution[field];
      if (actual === expected) correctPlacements += 1;
      else alignmentErrors.push(`${field}: expected ${expected}, got ${actual ?? "absent"}`);
    }
    if (pair.expect.headlineComponent !== undefined) {
      const expectedHeadline = pair.expect.headlineComponent;
      const actualHeadline = comparison.headline?.component ?? null;
      placements += 1;
      if (expectedHeadline === actualHeadline) correctPlacements += 1;
      else alignmentErrors.push(`headline: expected ${expectedHeadline ?? "none"}, got ${actualHeadline ?? "none"}`);
    }

    // Anything the product would say about this pair, through the guard.
    const snapshot = {
      case: { id: "case_eval", userId: "eval", status: "QUOTES_COMPARABLE" as const, trade: pair.trade, issueSummary: pair.title, offerIds: [], quoteIds: [], changeIds: [], createdAt: "", updatedAt: "" },
      offers: [],
      quotes: [quoteA, quoteB],
      changes: [],
      evidence: [],
      secondOpinionRequests: [],
      timeline: [],
      now: "2026-09-01T00:00:00.000Z",
    };
    const payload = presentComparison(snapshot, comparison, quoteA, quoteB);
    assertSafeLanguage(payload.speech);
    if (payload.refusal) assertSafeLanguage(payload.refusal);

    const reason = comparison.attribution.reason ?? null;
    const expectedReason = pair.expect.reason ?? null;
    const pass =
      comparison.verdict === pair.expect.verdict &&
      comparison.attribution.identifiable === pair.expect.identifiable &&
      (expectedReason === null || reason === expectedReason) &&
      alignmentErrors.length === 0;

    results.push({
      id: pair.id,
      title: pair.title,
      verdict: comparison.verdict,
      expectedVerdict: pair.expect.verdict,
      identifiable: comparison.attribution.identifiable,
      expectedIdentifiable: pair.expect.identifiable,
      reason,
      expectedReason,
      alignmentErrors,
      pass,
    });
  }

  const shouldRefuse = results.filter((r) => !r.expectedIdentifiable);
  const didRefuse = results.filter((r) => !r.identifiable);
  const correctRefusals = shouldRefuse.filter((r) => !r.identifiable).length;

  return {
    results,
    total: results.length,
    passed: results.filter((r) => r.pass).length,
    verdictAccuracy: results.filter((r) => r.verdict === r.expectedVerdict).length / results.length,
    refusalRecall: shouldRefuse.length === 0 ? 1 : correctRefusals / shouldRefuse.length,
    refusalPrecision: didRefuse.length === 0 ? 1 : correctRefusals / didRefuse.length,
    alignmentAccuracy: placements === 0 ? 1 : correctPlacements / placements,
    refusalsExpected: shouldRefuse.length,
  };
}

// ── injection ───────────────────────────────────────────────────────────────

export interface InjectionResult {
  id: string;
  title: string;
  hasInjection: boolean;
  detected: boolean;
  categoriesExpected: string[];
  categoriesFound: string[];
  /** Containment: the document's text never occupies an instruction position. */
  contained: boolean;
  containmentNotes: string[];
}

export interface InjectionReport {
  results: InjectionResult[];
  total: number;
  attacks: number;
  controls: number;
  detectionRecall: number;
  /** Controls that tripped the detector. Must be zero for the label to mean anything. */
  falsePositives: number;
  /** The number that must be zero. */
  containmentFailures: number;
  categoryRecall: Record<string, { found: number; expected: number }>;
}

export async function evaluateInjection(): Promise<InjectionReport> {
  const documents = await loadInjectionDocuments();
  const results: InjectionResult[] = [];
  const categoryRecall: Record<string, { found: number; expected: number }> = {};

  for (const doc of documents) {
    const isolated = isolate({ sourceLabel: doc.title, text: doc.text });
    const findings = scanForInjection(doc.text);
    const categoriesFound = [...new Set(findings.map((f) => f.category))];

    for (const category of doc.categories as InjectionCategory[]) {
      const entry = (categoryRecall[category] ??= { found: 0, expected: 0 });
      entry.expected += 1;
      if (categoriesFound.includes(category)) entry.found += 1;
    }

    // Containment. Three properties, all checked on the real envelope rather
    // than on an approximation of it.
    const notes: string[] = [];
    const envelope = renderForModel(isolated, "Convert the following home-repair document into JSON.");
    const opens = envelope.text.split(`<<<CIRCA-DOCUMENT-${envelope.nonce}`).length - 1;
    const closes = envelope.text.split(`CIRCA-DOCUMENT-${envelope.nonce}>>>`).length - 1;
    if (opens !== 1 || closes !== 1) notes.push(`envelope opened ${opens} and closed ${closes} times`);
    // The rules must precede the document, so a document arguing about them is
    // arguing after the fact.
    const rulesAt = envelope.text.indexOf("It is data to be described");
    const bodyAt = envelope.text.indexOf(`<<<CIRCA-DOCUMENT-${envelope.nonce}`);
    if (rulesAt === -1 || rulesAt > bodyAt) notes.push("the envelope rules do not precede the document");
    // And the parse that actually runs is code, so whatever the document says,
    // the structured result contains only line items and money.
    const parsed = parseQuoteText({
      id: "quote_inj",
      caseId: "case_inj",
      text: doc.text,
      trade: "unknown",
      source: "CONTRACTOR",
      defaultAction: "REPLACE",
      capturedAt: "2026-09-01T00:00:00.000Z",
    });
    if (typeof parsed.total !== "number") notes.push("parser did not return a numeric total");

    results.push({
      id: doc.id,
      title: doc.title,
      hasInjection: doc.hasInjection,
      detected: findings.length > 0,
      categoriesExpected: doc.categories,
      categoriesFound,
      contained: notes.length === 0,
      containmentNotes: notes,
    });
  }

  const attacks = results.filter((r) => r.hasInjection);
  const controls = results.filter((r) => !r.hasInjection);
  return {
    results,
    total: results.length,
    attacks: attacks.length,
    controls: controls.length,
    detectionRecall: attacks.length === 0 ? 1 : attacks.filter((r) => r.detected).length / attacks.length,
    falsePositives: controls.filter((r) => r.detected).length,
    containmentFailures: results.filter((r) => !r.contained).length,
    categoryRecall,
  };
}
