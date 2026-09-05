import { z } from "zod";
import { CentsSchema, PaymentMethodSchema } from "./quote.js";
import { WorkUnitSchema } from "./work.js";
import { VerificationCheckSchema } from "./verification.js";

/**
 * The repair case, its accepted baseline, and the changes proposed against it.
 *
 * The baseline is the part that makes this more than a quote checker. Once a
 * homeowner accepts a scope, every later request is measured against what was
 * recorded, not against what anyone remembers.
 */

export const CaseStatusSchema = z.enum([
  "NEW",
  "OFFER_CAPTURED",
  "VERIFYING",
  "SCOPE_NORMALISED",
  "SECOND_OPINION_REQUESTED",
  "QUOTES_COMPARABLE",
  "DECISION_RECORDED",
  "WORK_IN_PROGRESS",
  "CHANGE_PROPOSED",
  "COMPLETED",
  "CLOSED",
]);
export type CaseStatus = z.infer<typeof CaseStatusSchema>;

export const TradeSchema = z.enum([
  "roofing",
  "plumbing",
  "electrical",
  "hvac",
  "general",
  "unknown",
]);
export type Trade = z.infer<typeof TradeSchema>;

/**
 * The conditions surrounding the decision, as reported by the customer.
 *
 * These are the inputs to the DECISION_CONDITIONS rules. Every one of them is
 * `undefined` until someone says otherwise: "not stated" and "no" are different
 * facts, and collapsing them is how a checklist starts inventing findings.
 */
export const OfferContextSchema = z.object({
  solicited: z.boolean().optional(),
  urgencyClaim: z.string().optional(),
  decisionRequestedBy: z.enum(["IMMEDIATELY", "TODAY", "THIS_WEEK", "NO_DEADLINE"]).optional(),
  damageShownToCustomer: z.boolean().optional(),
  writtenScopeProvided: z.boolean().optional(),
  licenceNumberProvided: z.boolean().optional(),
  licenceVerified: z.boolean().optional(),
  insuranceEvidenceProvided: z.boolean().optional(),
  paymentMethodsRequested: z.array(PaymentMethodSchema).default([]),
  contractorFoundBy: z.enum(["DOOR_KNOCK", "PHONE_CALL", "REFERRAL", "SEARCH", "MARKETPLACE", "REPEAT"]).optional(),
  /** Named as an emergency by an independent party (a utility, an insurer, a fire service). */
  independentUrgencyConfirmation: z.boolean().optional(),
});
export type OfferContext = z.infer<typeof OfferContextSchema>;

export const OfferSchema = z.object({
  id: z.string(),
  caseId: z.string(),
  contractorName: z.string().optional(),
  companyName: z.string().optional(),
  /** The customer's own words. Untrusted text, stored verbatim, never used as instructions. */
  description: z.string(),
  quotedPrice: CentsSchema.optional(),
  depositRequested: CentsSchema.optional(),
  context: OfferContextSchema.default({ paymentMethodsRequested: [] }),
  capturedAt: z.string(),
});
export type Offer = z.infer<typeof OfferSchema>;

export const AgreementBaselineSchema = z.object({
  id: z.string(),
  caseId: z.string(),
  quoteId: z.string(),
  acceptedAt: z.string(),
  totalCents: CentsSchema,
  work: z.array(WorkUnitSchema),
  /** Verbatim exclusions carried forward: they are what the agreement says it does not cover. */
  exclusions: z.array(z.string()).default([]),
  /** Whether the accepted document contemplates concealed conditions changing the price. */
  concealedDamageClause: z.boolean().default(false),
});
export type AgreementBaseline = z.infer<typeof AgreementBaselineSchema>;

export const ScopeChangeStatusSchema = z.enum(["PROPOSED", "DOCUMENTED", "APPROVED", "DECLINED"]);
export type ScopeChangeStatus = z.infer<typeof ScopeChangeStatusSchema>;

export const ScopeChangeSchema = z.object({
  id: z.string(),
  caseId: z.string(),
  describedAs: z.string(),
  amountCents: CentsSchema.optional(),
  work: z.array(WorkUnitSchema).default([]),
  status: ScopeChangeStatusSchema.default("PROPOSED"),
  writtenChangeOrderProvided: z.boolean().optional(),
  conditionDocumented: z.boolean().optional(),
  revisedCompletionDateGiven: z.boolean().optional(),
  proposedAt: z.string(),
});
export type ScopeChange = z.infer<typeof ScopeChangeSchema>;

export const ScopeChangeVerdictSchema = z.enum([
  "OUTSIDE_BASELINE",
  "WITHIN_BASELINE",
  "PARTIALLY_OUTSIDE",
  "UNDETERMINED",
]);
export type ScopeChangeVerdict = z.infer<typeof ScopeChangeVerdictSchema>;

export const ScopeChangeReviewSchema = z.object({
  caseId: z.string(),
  changeId: z.string(),
  verdict: ScopeChangeVerdictSchema,
  alreadyAgreed: z.array(WorkUnitSchema).default([]),
  newWork: z.array(WorkUnitSchema).default([]),
  /** Work the change describes that could not be mapped, which is why UNDETERMINED exists. */
  unmapped: z.array(z.string()).default([]),
  baselineTotalCents: CentsSchema.optional(),
  changeAmountCents: CentsSchema.optional(),
  /** Increase over the accepted total, as a fraction. Reported, never judged. */
  increaseFraction: z.number().optional(),
  checks: z.array(VerificationCheckSchema).default([]),
  generatedAt: z.string(),
});
export type ScopeChangeReview = z.infer<typeof ScopeChangeReviewSchema>;

export const TimelineEventSchema = z.object({
  id: z.string(),
  caseId: z.string(),
  at: z.string(),
  kind: z.string(),
  summary: z.string(),
  data: z.record(z.string(), z.unknown()).optional(),
});
export type TimelineEvent = z.infer<typeof TimelineEventSchema>;

export const RepairCaseSchema = z.object({
  id: z.string(),
  userId: z.string(),
  status: CaseStatusSchema,
  trade: TradeSchema.default("unknown"),
  issueSummary: z.string(),
  postalCode: z.string().optional(),
  offerIds: z.array(z.string()).default([]),
  quoteIds: z.array(z.string()).default([]),
  changeIds: z.array(z.string()).default([]),
  acceptedBaselineId: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type RepairCase = z.infer<typeof RepairCaseSchema>;
