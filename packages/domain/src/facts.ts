import type {
  AgreementBaseline,
  Offer,
  Quote,
  RepairCase,
  ScopeChange,
  TimelineEvent,
} from "#schema";

/**
 * Everything a rule is allowed to read.
 *
 * A rule receives this and nothing else — no network, no clock beyond `now`, no
 * model. That is what makes a verification report reproducible: the same facts
 * give the same checks, on any machine, months later, which is the property a
 * record of a five-figure decision has to have.
 */
export interface CaseFacts {
  readonly case: RepairCase;
  readonly offers: readonly Offer[];
  readonly quotes: readonly Quote[];
  readonly baseline?: AgreementBaseline;
  readonly changes: readonly ScopeChange[];
  readonly evidence: readonly EvidenceItem[];
  readonly secondOpinionRequests: readonly SecondOpinionRequest[];
  readonly now: string;
}

export interface EvidenceItem {
  id: string;
  caseId: string;
  kind: "PHOTO" | "DOCUMENT" | "LICENCE_LOOKUP" | "INSURANCE_CERTIFICATE" | "NOTE";
  label: string;
  /** Where it came from and when. A verification result with no timestamp is not evidence. */
  source: string;
  recordedAt: string;
  /** For a licence lookup: what the register said. Never inferred. */
  outcome?: "MATCH" | "NO_MATCH" | "NOT_FOUND" | "REGISTER_UNAVAILABLE";
  documentId?: string;
}

export interface SecondOpinionRequest {
  id: string;
  caseId: string;
  providerId: string;
  providerName: string;
  scopeText: string;
  status: "REQUESTED" | "SCHEDULED" | "COMPLETED" | "DECLINED";
  requestedAt: string;
  quoteId?: string;
}

export interface CaseSnapshot extends CaseFacts {
  readonly timeline: readonly TimelineEvent[];
}

/** The offer under examination: the most recently captured one. */
export function currentOffer(facts: Pick<CaseFacts, "offers">): Offer | undefined {
  return [...facts.offers].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt)).at(-1);
}

export function contractorQuote(facts: Pick<CaseFacts, "quotes">): Quote | undefined {
  return facts.quotes.find((q) => q.source === "CONTRACTOR");
}

export function independentQuotes(facts: Pick<CaseFacts, "quotes">): Quote[] {
  return facts.quotes.filter((q) => q.source === "SECOND_OPINION" || q.source === "MARKETPLACE");
}
