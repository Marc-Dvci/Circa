import type {
  AgreementBaseline,
  CaseStatus,
  Comparison,
  Offer,
  OfferContext,
  Quote,
  RepairCase,
  ScopeChange,
  ScopeChangeReview,
  TimelineEvent,
  Trade,
  VerificationReport,
} from "#schema";
import { computeItemisation, formatCents } from "#schema";
import type { CaseFacts, CaseSnapshot, EvidenceItem, SecondOpinionRequest } from "#domain";
import { assertTransition, canTransition, newId } from "#domain";
import { buildNeutralScope, compareQuotes, normaliseLineItem, parseQuoteText, quoteFromSpokenOffer, type NeutralScope } from "#normalizer";
import { reviewScopeChange, runVerification } from "#verification";
import { VersionConflictError, type CaseRecord, type CaseRepository } from "./types.js";

/**
 * Everything the product can do to a case.
 *
 * The MCP tools are a thin translation of this class and hold no logic of their
 * own, which is what lets the CLI, the simulator's HTTP API and the MCP server
 * be three doors onto the same behaviour rather than three implementations that
 * drift.
 *
 * Every mutation appends to the timeline. Not for audit theatre: the change
 * review three weeks later reads the baseline out of it, and "what did we
 * originally agree" is a question the product promises to answer.
 */
/**
 * The timeline is customer-facing, so it is written in the customer's words.
 *
 * Alexa+ functional requirements are explicit that no API codes, tool names,
 * JSON or internal identifiers may appear in a customer-facing response, and the
 * dossier card reads these summaries straight out to the screen and to voice.
 * `change_6RHTGR is now DOCUMENTED` broke that rule three ways in five words.
 */
const CHANGE_STATUS_SUMMARY: Record<string, string> = {
  PROPOSED: "The extra work is recorded as proposed, not agreed",
  DOCUMENTED: "The extra work has been put in writing",
  ACCEPTED: "The extra work was accepted",
  DECLINED: "The extra work was declined",
  WITHDRAWN: "The extra work was withdrawn",
};

/** Plain-language names for the offer facts a customer can answer about. */
const ANSWER_SUMMARY: Record<string, { yes: string; no: string }> = {
  writtenScopeProvided: { yes: "There is something in writing", no: "Nothing has been put in writing" },
  damageShownToCustomer: { yes: "The damage was shown to you", no: "The damage has not been shown to you" },
  licenceNumberProvided: { yes: "A licence number was given", no: "No licence number was given" },
  insuranceEvidenceProvided: { yes: "Proof of insurance was given", no: "No proof of insurance was given" },
  unsolicitedApproach: { yes: "They approached you", no: "You approached them" },
  urgencyClaimed: { yes: "Urgency was claimed", no: "No urgency was claimed" },
  urgencyIndependentlyConfirmed: { yes: "The urgency was independently confirmed", no: "The urgency has not been independently confirmed" },
};

export function describeAnswers(answered: readonly string[], answers: Partial<OfferContext>): string {
  const parts: string[] = [];
  for (const field of answered) {
    const value = (answers as Record<string, unknown>)[field];
    const phrasing = ANSWER_SUMMARY[field];
    if (phrasing && typeof value === "boolean") parts.push(value ? phrasing.yes : phrasing.no);
    else if (field === "decisionRequestedBy" && typeof value === "string") parts.push("A decision was asked for by a set time");
  }
  return parts.length > 0 ? `${parts.join(". ")}.` : "You answered a question about the offer.";
}

export class CaseService {
  constructor(
    private readonly repository: CaseRepository,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {}

  describe(): string {
    return this.repository.describe();
  }

  // ── reads ──────────────────────────────────────────────────────────────────

  async snapshot(caseId: string): Promise<CaseSnapshot | undefined> {
    const record = await this.repository.get(caseId);
    return record ? toSnapshot(record, this.clock()) : undefined;
  }

  async require(caseId: string): Promise<CaseRecord> {
    const record = await this.repository.get(caseId);
    if (!record) throw new Error("I do not have a record of that repair.");
    return record;
  }

  async list(userId: string): Promise<RepairCase[]> {
    return this.repository.listByUser(userId);
  }

  async verification(caseId: string): Promise<VerificationReport> {
    return runVerification(await this.facts(caseId));
  }

  async facts(caseId: string): Promise<CaseFacts> {
    return toSnapshot(await this.require(caseId), this.clock());
  }

  // ── writes ─────────────────────────────────────────────────────────────────

  /**
   * Read, apply, write, and retry once on a version conflict.
   *
   * One retry rather than a loop: two turns of the same conversation racing is
   * ordinary, and a third is a bug somewhere else that a retry loop would hide.
   */
  private async mutate<T>(
    caseId: string,
    apply: (record: CaseRecord) => { result: T; events: Omit<TimelineEvent, "id" | "caseId" | "at">[]; status?: CaseStatus },
  ): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const record = await this.require(caseId);
      const { result, events, status } = apply(record);
      const now = this.clock();
      for (const event of events) {
        record.timeline.push({ id: newId("evt"), caseId, at: now, ...event });
      }
      if (status && status !== record.case.status) {
        assertTransition(record.case.status, status);
        record.case.status = status;
      }
      record.case.updatedAt = now;
      try {
        await this.repository.put(record);
        return result;
      } catch (error) {
        if (error instanceof VersionConflictError && attempt === 0) continue;
        throw error;
      }
    }
    throw new Error(`could not write case ${caseId} without a conflict`);
  }

  async startCase(input: {
    userId: string;
    issueSummary: string;
    trade?: Trade;
    postalCode?: string;
  }): Promise<RepairCase> {
    const now = this.clock();
    const repairCase: RepairCase = {
      id: newId("case"),
      userId: input.userId,
      status: "NEW",
      trade: input.trade ?? "unknown",
      issueSummary: input.issueSummary,
      offerIds: [],
      quoteIds: [],
      changeIds: [],
      createdAt: now,
      updatedAt: now,
    };
    if (input.postalCode) repairCase.postalCode = input.postalCode;
    const record: CaseRecord = {
      version: 0,
      case: repairCase,
      offers: [],
      quotes: [],
      changes: [],
      evidence: [],
      secondOpinionRequests: [],
      timeline: [
        {
          id: newId("evt"),
          caseId: repairCase.id,
          at: now,
          kind: "CASE_OPENED",
          summary: input.issueSummary,
        },
      ],
    };
    await this.repository.create(record);
    return repairCase;
  }

  async captureOffer(input: {
    caseId: string;
    description: string;
    contractorName?: string;
    companyName?: string;
    quotedPrice?: number;
    depositRequested?: number;
    context?: Partial<OfferContext>;
    trade?: Trade;
  }): Promise<{ offer: Offer; quote?: Quote; report: VerificationReport }> {
    return this.mutate(input.caseId, (record) => {
      const now = this.clock();
      const trade = input.trade ?? record.case.trade;
      const offer: Offer = {
        id: newId("offer"),
        caseId: input.caseId,
        description: input.description,
        context: { paymentMethodsRequested: [], ...(input.context ?? {}) },
        capturedAt: now,
      };
      if (input.contractorName) offer.contractorName = input.contractorName;
      if (input.companyName) offer.companyName = input.companyName;
      if (input.quotedPrice !== undefined) offer.quotedPrice = input.quotedPrice;
      if (input.depositRequested !== undefined) offer.depositRequested = input.depositRequested;

      record.offers.push(offer);
      record.case.offerIds.push(offer.id);
      if (input.trade) record.case.trade = input.trade;

      // A spoken offer with a price is a quote, and the itemisation field will
      // say what kind: a single number for a paragraph of work.
      let quote: Quote | undefined;
      if (input.quotedPrice !== undefined && !record.quotes.some((q) => q.source === "CONTRACTOR")) {
        quote = quoteFromSpokenOffer({
          id: newId("quote"),
          caseId: input.caseId,
          description: input.description,
          total: input.quotedPrice,
          trade,
          ...(input.contractorName || input.companyName
            ? { contractorName: input.companyName ?? input.contractorName! }
            : {}),
          ...(input.depositRequested !== undefined ? { deposit: input.depositRequested } : {}),
          capturedAt: now,
        });
        record.quotes.push(quote);
        record.case.quoteIds.push(quote.id);
      }

      const report = runVerification(toSnapshot(record, now));
      return {
        result: { offer, quote, report },
        status: "OFFER_CAPTURED",
        events: [
          {
            kind: "OFFER_CAPTURED",
            summary: input.contractorName || input.companyName ? `Offer from ${input.companyName ?? input.contractorName}` : "Offer captured",
            data: { offerId: offer.id, quotedPrice: input.quotedPrice ?? null },
          },
        ],
      };
    });
  }

  /**
   * Answer one or more verification questions.
   *
   * Merges into the latest offer's context. Merging rather than replacing,
   * because the customer answers these one at a time across a conversation, and
   * an answer given two turns ago must not be erased by the next tool call.
   */
  async answerVerification(input: {
    caseId: string;
    answers: Partial<OfferContext>;
  }): Promise<VerificationReport> {
    return this.mutate(input.caseId, (record) => {
      const offer = record.offers.at(-1);
      if (!offer) throw new Error("nothing has been captured on this case to answer about");
      const before = { ...offer.context };
      offer.context = { ...offer.context, ...input.answers };
      const answered = Object.keys(input.answers).filter(
        (k) => (before as Record<string, unknown>)[k] !== (input.answers as Record<string, unknown>)[k],
      );
      const report = runVerification(toSnapshot(record, this.clock()));
      return {
        result: report,
        status: canTransition(record.case.status, "VERIFYING") ? "VERIFYING" : undefined,
        events: answered.length
          ? [
              {
                kind: "VERIFICATION_ANSWERED",
                summary: describeAnswers(answered, input.answers),
                data: { ...input.answers },
              },
            ]
          : [],
      };
    });
  }

  async addEvidence(input: {
    caseId: string;
    kind: EvidenceItem["kind"];
    label: string;
    source: string;
    outcome?: EvidenceItem["outcome"];
    documentId?: string;
  }): Promise<EvidenceItem> {
    return this.mutate(input.caseId, (record) => {
      const item: EvidenceItem = {
        id: newId("ev"),
        caseId: input.caseId,
        kind: input.kind,
        label: input.label,
        source: input.source,
        recordedAt: this.clock(),
      };
      if (input.outcome) item.outcome = input.outcome;
      if (input.documentId) item.documentId = input.documentId;
      record.evidence.push(item);
      return {
        result: item,
        events: [{ kind: "EVIDENCE_ADDED", summary: `${input.kind}: ${input.label}`, data: { evidenceId: item.id } }],
      };
    });
  }

  /**
   * The same neutral scope, read without recording that it was built again.
   *
   * `request_second_opinion` needs the scope text to send it, and calling
   * `structureScope` for it wrote a second "Independent assessment scope for 6
   * components" into the timeline, one second after the first. The timeline is
   * the record the change review reads three weeks later, so an entry that
   * describes no decision does not belong in it.
   */
  async peekScope(caseId: string): Promise<NeutralScope> {
    const record = await this.require(caseId);
    const offer = record.offers.at(-1);
    if (!offer) throw new Error("nothing has been captured on this case to build a scope from");
    return buildNeutralScope(offer, record.case.trade, this.clock());
  }

  async structureScope(caseId: string): Promise<NeutralScope> {
    return this.mutate(caseId, (record) => {
      const offer = record.offers.at(-1);
      if (!offer) throw new Error("nothing has been captured on this case to build a scope from");
      const scope = buildNeutralScope(offer, record.case.trade, this.clock());
      return {
        result: scope,
        status: canTransition(record.case.status, "SCOPE_NORMALISED") ? "SCOPE_NORMALISED" : undefined,
        events: [
          {
            kind: "SCOPE_STRUCTURED",
            summary: `Independent assessment scope for ${scope.inspectLabels.length} component${scope.inspectLabels.length === 1 ? "" : "s"}`,
            data: { inspect: scope.inspect, withheld: scope.withheld.map((w) => w.what) },
          },
        ],
      };
    });
  }

  async requestSecondOpinion(input: {
    caseId: string;
    providerId: string;
    providerName: string;
    scopeText: string;
  }): Promise<SecondOpinionRequest> {
    return this.mutate(input.caseId, (record) => {
      const request: SecondOpinionRequest = {
        id: newId("req"),
        caseId: input.caseId,
        providerId: input.providerId,
        providerName: input.providerName,
        scopeText: input.scopeText,
        status: "REQUESTED",
        requestedAt: this.clock(),
      };
      record.secondOpinionRequests.push(request);
      return {
        result: request,
        status: canTransition(record.case.status, "SECOND_OPINION_REQUESTED") ? "SECOND_OPINION_REQUESTED" : undefined,
        events: [
          { kind: "SECOND_OPINION_REQUESTED", summary: `Assessment requested from ${input.providerName}`, data: { requestId: request.id } },
        ],
      };
    });
  }

  async addQuote(input: {
    caseId: string;
    text?: string;
    quote?: Omit<Quote, "id" | "caseId">;
    source: Quote["source"];
    contractorName?: string;
    documentId?: string;
    requestId?: string;
  }): Promise<Quote> {
    return this.mutate(input.caseId, (record) => {
      const id = newId("quote");
      let quote: Quote;
      if (input.text !== undefined) {
        quote = parseQuoteText({
          id,
          caseId: input.caseId,
          text: input.text,
          trade: record.case.trade,
          source: input.source,
          defaultAction: "REPLACE",
          ...(input.contractorName ? { contractorName: input.contractorName } : {}),
          ...(input.documentId ? { documentId: input.documentId } : {}),
          capturedAt: this.clock(),
        });
      } else if (input.quote) {
        quote = { ...input.quote, id, caseId: input.caseId };
        quote.itemisation = computeItemisation(quote);
      } else {
        throw new Error("addQuote needs either the quote text or a structured quote");
      }
      record.quotes.push(quote);
      record.case.quoteIds.push(quote.id);
      if (input.requestId) {
        const request = record.secondOpinionRequests.find((r) => r.id === input.requestId);
        if (request) {
          request.status = "COMPLETED";
          request.quoteId = quote.id;
        }
      }
      const comparable = record.quotes.length >= 2;
      return {
        result: quote,
        status: comparable && canTransition(record.case.status, "QUOTES_COMPARABLE") ? "QUOTES_COMPARABLE" : undefined,
        events: [
          {
            kind: "QUOTE_ADDED",
            summary: `${input.source === "CONTRACTOR" ? "Contractor quote" : "Independent quote"}${quote.contractorName ? ` from ${quote.contractorName}` : ""}`,
            data: { quoteId: quote.id, total: quote.total, itemisation: quote.itemisation?.level ?? null },
          },
        ],
      };
    });
  }

  async compare(input: { caseId: string; quoteAId?: string; quoteBId?: string }): Promise<{
    comparison: Comparison;
    quoteA: Quote;
    quoteB: Quote;
  }> {
    const record = await this.require(input.caseId);
    const quoteA = input.quoteAId
      ? record.quotes.find((q) => q.id === input.quoteAId)
      : record.quotes.find((q) => q.source === "CONTRACTOR");
    const quoteB = input.quoteBId
      ? record.quotes.find((q) => q.id === input.quoteBId)
      : record.quotes.find((q) => q.source !== "CONTRACTOR");
    if (!quoteA || !quoteB) throw new Error("this case does not have two quotes to compare yet");
    return { comparison: compareQuotes(quoteA, quoteB, this.clock()), quoteA, quoteB };
  }

  /**
   * Record what the customer accepted.
   *
   * The baseline is written once and never rewritten. `acceptScope` on a case
   * that already has one throws, because a baseline that can be replaced is not
   * a record of an agreement, it is a note.
   */
  async acceptScope(input: { caseId: string; quoteId: string }): Promise<AgreementBaseline> {
    return this.mutate(input.caseId, (record) => {
      if (record.baseline) throw new Error("You have already accepted a scope on this repair.");
      const quote = record.quotes.find((q) => q.id === input.quoteId);
      if (!quote) throw new Error("I do not have that quote on this repair.");
      const work = quote.lineItems.flatMap((li) => li.work);
      const baseline: AgreementBaseline = {
        id: newId("base"),
        caseId: input.caseId,
        quoteId: quote.id,
        acceptedAt: this.clock(),
        totalCents: quote.total,
        work,
        exclusions: [...quote.exclusions],
        concealedDamageClause: quote.concealedDamageClause ?? false,
      };
      record.baseline = baseline;
      record.case.acceptedBaselineId = baseline.id;
      return {
        result: baseline,
        status: "DECISION_RECORDED",
        events: [
          {
            kind: "SCOPE_ACCEPTED",
            summary: `Accepted ${quote.contractorName ?? "the quote"} at ${formatCents(quote.total)}, covering ${work.length} piece${work.length === 1 ? "" : "s"} of work`,
            data: { baselineId: baseline.id, quoteId: quote.id, total: quote.total },
          },
        ],
      };
    });
  }

  async startWork(caseId: string): Promise<RepairCase> {
    return this.mutate(caseId, (record) => ({
      result: record.case,
      status: "WORK_IN_PROGRESS",
      events: [{ kind: "WORK_STARTED", summary: "Work started" }],
    }));
  }

  async recordScopeChange(input: {
    caseId: string;
    describedAs: string;
    amountCents?: number;
    writtenChangeOrderProvided?: boolean;
    conditionDocumented?: boolean;
    revisedCompletionDateGiven?: boolean;
  }): Promise<{ change: ScopeChange; review: ScopeChangeReview }> {
    return this.mutate(input.caseId, (record) => {
      const normalised = normaliseLineItem(input.describedAs, record.case.trade, "REPLACE");
      const change: ScopeChange = {
        id: newId("change"),
        caseId: input.caseId,
        describedAs: input.describedAs,
        work: normalised.work,
        status: "PROPOSED",
        proposedAt: this.clock(),
      };
      if (input.amountCents !== undefined) change.amountCents = input.amountCents;
      if (input.writtenChangeOrderProvided !== undefined) change.writtenChangeOrderProvided = input.writtenChangeOrderProvided;
      if (input.conditionDocumented !== undefined) change.conditionDocumented = input.conditionDocumented;
      if (input.revisedCompletionDateGiven !== undefined) change.revisedCompletionDateGiven = input.revisedCompletionDateGiven;

      record.changes.push(change);
      record.case.changeIds.push(change.id);

      // A contractor asking for more money is evidence the job started, and a
      // customer who never said "they have begun" is the ordinary case rather
      // than a lapse. So DECISION_RECORDED advances through WORK_IN_PROGRESS
      // here, rather than the change being recorded against a case that still
      // claims nobody has been on the roof. The inference is written to the
      // timeline: a status the product decided for itself and did not say so is
      // a status the customer cannot correct.
      if (record.case.status === "DECISION_RECORDED") {
        assertTransition(record.case.status, "WORK_IN_PROGRESS");
        record.case.status = "WORK_IN_PROGRESS";
        record.timeline.push({
          id: newId("evt"),
          caseId: input.caseId,
          at: this.clock(),
          kind: "WORK_STARTED",
          summary: "Recorded as under way, because a change was proposed against the accepted scope",
        });
      }

      const review = reviewScopeChange(
        change,
        record.baseline,
        normalised.unmapped ? [input.describedAs] : [],
        this.clock(),
      );
      return {
        result: { change, review },
        status: canTransition(record.case.status, "CHANGE_PROPOSED") ? "CHANGE_PROPOSED" : undefined,
        events: [
          {
            kind: "CHANGE_PROPOSED",
            summary: input.describedAs,
            data: { changeId: change.id, amountCents: input.amountCents ?? null, verdict: review.verdict },
          },
        ],
      };
    });
  }

  async reviewChange(input: { caseId: string; changeId?: string }): Promise<ScopeChangeReview> {
    const record = await this.require(input.caseId);
    const change = input.changeId ? record.changes.find((c) => c.id === input.changeId) : record.changes.at(-1);
    if (!change) throw new Error("no proposed change on this case");
    const normalised = normaliseLineItem(change.describedAs, record.case.trade, "REPLACE");
    return reviewScopeChange(change, record.baseline, normalised.unmapped ? [change.describedAs] : [], this.clock());
  }

  async setChangeStatus(input: { caseId: string; changeId: string; status: ScopeChange["status"] }): Promise<ScopeChange> {
    return this.mutate(input.caseId, (record) => {
      const change = record.changes.find((c) => c.id === input.changeId);
      if (!change) throw new Error("I do not have that proposed change on this repair.");
      change.status = input.status;
      return {
        result: change,
        events: [
          {
            kind: "CHANGE_STATUS",
            summary: CHANGE_STATUS_SUMMARY[input.status] ?? `The proposed change is now ${input.status.toLowerCase()}`,
            data: { status: input.status },
          },
        ],
      };
    });
  }

  async deleteCase(caseId: string): Promise<boolean> {
    return this.repository.delete(caseId);
  }
}

function toSnapshot(record: CaseRecord, now: string): CaseSnapshot {
  return {
    case: record.case,
    offers: record.offers,
    quotes: record.quotes,
    changes: record.changes,
    ...(record.baseline ? { baseline: record.baseline } : {}),
    evidence: record.evidence,
    secondOpinionRequests: record.secondOpinionRequests,
    timeline: record.timeline,
    now,
  };
}
