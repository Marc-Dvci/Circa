import type {
  Comparison,
  Quote,
  ScopeChangeReview,
  VerificationCheck,
  VerificationReport,
} from "#schema";
import { assertSafeLanguage, formatCents } from "#schema";
import type { CaseSnapshot } from "#domain";
import { contractorQuote, currentOffer } from "#domain";
import { agenda, explainScopeChange, summarise } from "#verification";
import { comparisonHeadline, explainComparison, type NeutralScope } from "#normalizer";
import type { ProviderMatch } from "#providers";
import { providerHeadline } from "#providers";
import { labelFor } from "#taxonomy";

/**
 * One place that decides what a result *says*.
 *
 * Three surfaces read a case — the MCP tool result, the CLI and the simulator's
 * HTTP API — and a fourth, voice, is the one that matters. If each rendered the
 * engine's output for itself they would drift, and the drift would be invisible:
 * a screen showing four open items beside a voice line saying three is not a
 * layout bug, it is two different opinions about the same repair.
 *
 * So the payload is built once, here, complete with the sentence to speak and
 * the rows to draw, and the views are dumb. Everything a view shows, `speech`
 * has already said, which is what makes voice-only a real path rather than a
 * degraded one.
 */

export interface ViewRow {
  label: string;
  value: string;
  attention?: boolean;
}

export interface ViewAction {
  label: string;
  tool: string;
  arguments: Record<string, unknown>;
}

export interface ViewPayload {
  view: string;
  caseId: string;
  headline: string;
  speech: string;
  rows: ViewRow[];
  actions: ViewAction[];
  refusal?: string;
  [key: string]: unknown;
}

const SHORT_STATUS: Record<string, string> = {
  NEW: "Just opened",
  OFFER_CAPTURED: "Offer recorded",
  VERIFYING: "Checking",
  SCOPE_NORMALISED: "Scope prepared",
  SECOND_OPINION_REQUESTED: "Waiting on an assessment",
  QUOTES_COMPARABLE: "Two quotes in",
  DECISION_RECORDED: "Scope accepted",
  WORK_IN_PROGRESS: "Work under way",
  CHANGE_PROPOSED: "A change has been proposed",
  COMPLETED: "Completed",
  CLOSED: "Closed",
};

/** A title short enough for a device read from across a room. */
export function shortTitle(issueSummary: string): string {
  const words = issueSummary.split(/\s+/).slice(0, 5).join(" ");
  return words.length > 42 ? `${words.slice(0, 39)}…` : words;
}

function checkRow(check: VerificationCheck): ViewRow {
  const label = check.ruleId
    .split(".")[1]!
    .replace(/_/g, " ")
    .replace(/^\w/, (c) => c.toUpperCase());
  const value =
    check.status === "ATTENTION" ? "Worth knowing" : check.status === "VERIFY" ? "Not established" : "Done";
  return { label, value, attention: check.status === "ATTENTION" };
}

// ── verification ────────────────────────────────────────────────────────────

export function presentVerification(snapshot: CaseSnapshot, report: VerificationReport): ViewPayload {
  const items = agenda(report, 4);
  const offer = currentOffer(snapshot);
  const quote = contractorQuote(snapshot);

  const rows: ViewRow[] = items.map(checkRow);
  if (quote?.deposit !== undefined) {
    rows.push({
      label: "Deposit asked for",
      value: formatCents(quote.deposit),
      attention: report.checks.some((c) => c.ruleId === "conditions.deposit_share" && c.status === "ATTENTION"),
    });
  }
  if (offer?.quotedPrice !== undefined) {
    rows.push({ label: "Quoted", value: formatCents(offer.quotedPrice) });
  }

  const actions: ViewAction[] = [];
  const withNextStep = items.find((c) => c.nextStep);
  if (snapshot.quotes.length < 2) {
    actions.push({
      label: "Get an independent look",
      tool: "structure_scope",
      arguments: { caseId: snapshot.case.id },
    });
  } else {
    actions.push({ label: "Compare the quotes", tool: "compare_quotes", arguments: { caseId: snapshot.case.id } });
  }
  actions.push({ label: "Show the whole record", tool: "get_repair_dossier", arguments: { caseId: snapshot.case.id } });

  const speech = [summarise(report), withNextStep?.nextStep].filter(Boolean).join(" ");

  return {
    view: "ui://circa/verification",
    caseId: snapshot.case.id,
    headline: shortTitle(snapshot.case.issueSummary),
    speech: assertSafeLanguage(speech),
    rows,
    actions,
    counts: report.counts,
    completedApplicable: report.completedApplicable,
    totalApplicable: report.totalApplicable,
    status: snapshot.case.status,
    checks: report.checks.map((c) => ({
      ruleId: c.ruleId,
      dimension: c.dimension,
      status: c.status,
      statement: c.statement,
      basis: c.basis,
      ...(c.nextStep ? { nextStep: c.nextStep } : {}),
    })),
  };
}

// ── comparison ──────────────────────────────────────────────────────────────

const WHAT_WOULD_HELP: Record<string, string> = {
  LUMP_SUM: "Ask for the same quote itemised, with a price against each line. Then the same comparison can answer it.",
  INSUFFICIENT_ATTRIBUTION: "Ask for the remaining work to be priced line by line so the totals add up to the total.",
  UNMAPPED_WORK: "Ask for the work to be described in the trade's usual terms, one component per line.",
  NO_COMMON_SCOPE: "These two are answering different questions. Ask the second assessor to price the same list of work.",
  DIFFERENT_KIND_OF_WORK: "One of these is an assessment, not a repair. A repair quote from the same assessor would be comparable.",
};

export function presentComparison(
  snapshot: CaseSnapshot,
  comparison: Comparison,
  quoteA: Quote,
  quoteB: Quote,
): ViewPayload {
  const lines = explainComparison(comparison, quoteA, quoteB);
  const rows: ViewRow[] = [];
  rows.push({
    label: "Same work in both",
    value: `${comparison.coverage.shared} of ${comparison.coverage.shared + comparison.coverage.onlyA + comparison.coverage.onlyB}`,
  });
  if (comparison.headline) {
    rows.push({
      label: comparison.headline.label,
      value: comparison.headline.presentIn === "A" ? "First quote only" : "Second quote only",
      attention: true,
    });
  }
  if (comparison.attribution.identifiable) {
    rows.push({ label: "Different scope", value: formatCents(Math.abs(comparison.attribution.scopeDifferenceCents ?? 0)) });
    rows.push({ label: "Same work, different price", value: formatCents(Math.abs(comparison.attribution.rateDifferenceCents ?? 0)) });
    rows.push({
      label: "Unaccounted for",
      value: formatCents(Math.abs(comparison.attribution.residualCents ?? 0)),
      attention: Math.abs(comparison.attribution.residualCents ?? 0) >= 100,
    });
  } else {
    rows.push({ label: "Where the money sits", value: "Cannot be said", attention: true });
  }

  const actions: ViewAction[] = [
    { label: "Accept the second quote", tool: "accept_scope", arguments: { caseId: snapshot.case.id, quoteId: quoteB.id } },
  ];

  const payload: ViewPayload = {
    view: "ui://circa/comparison",
    caseId: snapshot.case.id,
    headline: comparisonHeadline(comparison),
    speech: assertSafeLanguage(lines.join(" ")),
    detail: lines.join("\n"),
    rows,
    actions,
    quoteA: { name: quoteA.contractorName ?? "First quote", total: formatCents(quoteA.total), itemisation: quoteA.itemisation?.level },
    quoteB: { name: quoteB.contractorName ?? "Second quote", total: formatCents(quoteB.total), itemisation: quoteB.itemisation?.level },
    verdict: comparison.verdict,
    identifiable: comparison.attribution.identifiable,
    overlap: comparison.coverage.overlap,
    alignments: comparison.alignments.map((a) => ({
      label: a.label,
      status: a.status,
      relation: a.relation,
      amountA: a.amountA !== undefined ? formatCents(a.amountA) : null,
      amountB: a.amountB !== undefined ? formatCents(a.amountB) : null,
    })),
  };
  if (!comparison.attribution.identifiable) {
    const reason = comparison.attribution.reason ?? "LUMP_SUM";
    payload.refusal = assertSafeLanguage(WHAT_WOULD_HELP[reason] ?? WHAT_WOULD_HELP["LUMP_SUM"]!);
    payload["notIdentifiableReason"] = reason;
  }
  return payload;
}

// ── change orders ───────────────────────────────────────────────────────────

const CHANGE_HEADLINE: Record<string, string> = {
  OUTSIDE_BASELINE: "Not in what you accepted",
  PARTIALLY_OUTSIDE: "Partly outside what you accepted",
  WITHIN_BASELINE: "Already in what you accepted",
  UNDETERMINED: "I cannot place this against your agreement",
};

export function presentChange(snapshot: CaseSnapshot, review: ScopeChangeReview): ViewPayload {
  const change = snapshot.changes.find((c) => c.id === review.changeId);
  const rows: ViewRow[] = [];
  rows.push({ label: "Against your agreement", value: CHANGE_HEADLINE[review.verdict]!, attention: review.verdict !== "WITHIN_BASELINE" });
  if (review.newWork.length > 0) {
    rows.push({ label: "New work", value: review.newWork.map((w) => labelFor(w.component)).join(", ") });
  }
  if (review.alreadyAgreed.length > 0) {
    rows.push({ label: "Already agreed", value: review.alreadyAgreed.map((w) => labelFor(w.component)).join(", ") });
  }
  if (review.baselineTotalCents !== undefined) {
    rows.push({ label: "Accepted total", value: formatCents(review.baselineTotalCents) });
  }
  if (review.increaseFraction !== undefined) {
    rows.push({
      label: "Increase",
      value: `${Math.round(review.increaseFraction * 100)}%`,
      attention: review.increaseFraction >= 0.2,
    });
  }
  for (const check of review.checks.filter((c) => c.status !== "CLEAR" && c.nextStep)) {
    rows.push({ label: check.ruleId.split(".")[1]!.replace(/_/g, " "), value: "Not yet", attention: check.status === "ATTENTION" });
  }

  const actions: ViewAction[] = [
    {
      label: "Ask for it in writing",
      tool: "set_change_status",
      arguments: { caseId: snapshot.case.id, changeId: review.changeId, status: "DOCUMENTED" },
    },
    {
      label: "Show what I agreed to",
      tool: "get_repair_dossier",
      arguments: { caseId: snapshot.case.id },
    },
  ];

  const spoken = explainScopeChange(review);
  return {
    view: "ui://circa/change",
    caseId: snapshot.case.id,
    changeId: review.changeId,
    headline: CHANGE_HEADLINE[review.verdict]!,
    describedAs: change?.describedAs ?? "",
    amount: review.changeAmountCents !== undefined ? `+${formatCents(review.changeAmountCents)}` : "",
    speech: assertSafeLanguage(spoken.join(" ")),
    rows,
    actions,
    verdict: review.verdict,
    checks: review.checks,
  };
}

// ── providers ───────────────────────────────────────────────────────────────

export function presentProviders(
  caseId: string,
  matches: readonly ProviderMatch[],
  notice: string,
  scope?: NeutralScope,
): ViewPayload {
  const speech =
    matches.length === 0
      ? "I could not find an independent assessor for that trade in your area in this directory."
      : `${matches.length === 1 ? "There is one" : `There are ${matches.length}`} who could look at this. ${providerHeadline(matches[0]!)}. ${
          matches[0]!.independentOfOutcome
            ? "That one sells assessments and not repairs, so the fee is the same whatever they find."
            : "That one also does repairs, so they may follow the assessment with their own quote."
        }`;

  return {
    view: "ui://circa/providers",
    caseId,
    headline: `${matches.length} available`,
    speech: assertSafeLanguage(speech),
    rows: [],
    actions: [],
    notice,
    matches: matches.map((m) => ({
      id: m.provider.id,
      name: m.provider.name,
      headline: providerHeadline(m),
      reasons: m.reasons,
      independentOfOutcome: m.independentOfOutcome,
      assessmentFee: formatCents(m.provider.assessmentFeeCents),
      nextAvailableDays: m.provider.nextAvailableDays,
    })),
    ...(scope
      ? {
          scope: {
            inspect: scope.inspectLabels,
            withheld: scope.withheld,
            text: scope.text,
          },
        }
      : {}),
  };
}

// ── dossier ─────────────────────────────────────────────────────────────────

export function presentDossier(snapshot: CaseSnapshot, report: VerificationReport): ViewPayload {
  const rows: ViewRow[] = [];
  for (const quote of snapshot.quotes) {
    rows.push({
      label: quote.contractorName ?? (quote.source === "CONTRACTOR" ? "The contractor" : "Independent"),
      value: `${formatCents(quote.total)} · ${quote.itemisation?.level.toLowerCase().replace("_", " ") ?? "unparsed"}`,
    });
  }
  if (snapshot.baseline) {
    rows.push({ label: "Accepted", value: formatCents(snapshot.baseline.totalCents) });
  }
  rows.push({
    label: "Checks complete",
    value: `${report.completedApplicable} of ${report.totalApplicable}`,
    attention: report.counts.attention > 0,
  });

  const speech = snapshot.baseline
    ? `You accepted ${formatCents(snapshot.baseline.totalCents)} covering ${snapshot.baseline.work.length} pieces of work, on ${snapshot.baseline.acceptedAt.slice(0, 10)}.`
    : summarise(report);

  return {
    view: "ui://circa/dossier",
    caseId: snapshot.case.id,
    headline: shortTitle(snapshot.case.issueSummary),
    statusLabel: SHORT_STATUS[snapshot.case.status] ?? snapshot.case.status,
    speech: assertSafeLanguage(speech),
    rows,
    actions: [],
    status: snapshot.case.status,
    timeline: snapshot.timeline.map((e) => ({ when: e.at.slice(0, 16).replace("T", " "), kind: e.kind, summary: e.summary })),
    quotes: snapshot.quotes.map((q) => ({
      id: q.id,
      name: q.contractorName ?? null,
      source: q.source,
      total: formatCents(q.total),
      itemisation: q.itemisation?.level ?? null,
      lineItems: q.lineItems.length,
      exclusions: q.exclusions,
    })),
    ...(snapshot.baseline
      ? {
          baseline: {
            acceptedAt: snapshot.baseline.acceptedAt,
            total: formatCents(snapshot.baseline.totalCents),
            work: snapshot.baseline.work.map((w) => labelFor(w.component)),
            exclusions: snapshot.baseline.exclusions,
          },
        }
      : {}),
  };
}
