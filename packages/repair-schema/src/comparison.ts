import { z } from "zod";
import { CentsSchema } from "./quote.js";
import { WorkActionSchema, ComponentIdSchema } from "./work.js";

/**
 * The result of comparing two quotes.
 *
 * The shape encodes the product's central claim: a price difference is not a
 * finding until the scopes are aligned, and an unexplained residual is only
 * reportable when both documents attribute their money to the work they
 * describe. `attribution.identifiable` is false far more often than it is true,
 * and that is the correct behaviour rather than a gap.
 */

export const AlignmentStatusSchema = z.enum(["SHARED", "ONLY_A", "ONLY_B"]);
export type AlignmentStatus = z.infer<typeof AlignmentStatusSchema>;

/**
 * How the two sides came to be called the same work.
 *
 * `SUBSUMED_BY_A` means A named a larger job that contains what B named — a full
 * roof replacement against eight shingles. The two are related, and they are not
 * equivalent, and a comparison that reported them as a plain match would be
 * hiding the most important thing about the pair.
 */
export const AlignmentRelationSchema = z.enum(["EXACT", "SUBSUMED_BY_A", "SUBSUMED_BY_B"]);
export type AlignmentRelation = z.infer<typeof AlignmentRelationSchema>;

export const AlignmentSchema = z.object({
  component: ComponentIdSchema,
  action: WorkActionSchema,
  status: AlignmentStatusSchema,
  relation: AlignmentRelationSchema.default("EXACT"),
  /** Ancillary work — permits, disposal, a trip charge — is never the headline difference. */
  ancillary: z.boolean().default(false),
  lineItemsA: z.array(z.string()).default([]),
  lineItemsB: z.array(z.string()).default([]),
  amountA: CentsSchema.optional(),
  amountB: CentsSchema.optional(),
  /** Human label for the component, resolved from the taxonomy at build time. */
  label: z.string(),
});
export type Alignment = z.infer<typeof AlignmentSchema>;

export const NotIdentifiableReasonSchema = z.enum([
  /** One or both quotes are a single number for a paragraph of work. */
  "LUMP_SUM",
  /** Line items exist but too little of the total is attributed to them. */
  "INSUFFICIENT_ATTRIBUTION",
  /** Too little of the described work could be mapped to the taxonomy. */
  "UNMAPPED_WORK",
  /** The two documents share almost no work. Comparing them is a category error. */
  "NO_COMMON_SCOPE",
  /** One quote is an inspection or assessment and the other is a repair. */
  "DIFFERENT_KIND_OF_WORK",
]);
export type NotIdentifiableReason = z.infer<typeof NotIdentifiableReasonSchema>;

export const AttributionSchema = z.object({
  identifiable: z.boolean(),
  reason: NotIdentifiableReasonSchema.optional(),
  /** Work priced in one quote and absent from the other. */
  scopeDifferenceCents: CentsSchema.optional(),
  /** Same component and action, different amount. */
  rateDifferenceCents: CentsSchema.optional(),
  /** total(A) - total(B) - scope - rate. What the documents do not account for. */
  residualCents: CentsSchema.optional(),
});
export type Attribution = z.infer<typeof AttributionSchema>;

export const ComparisonVerdictSchema = z.enum([
  /** Same work, comparable totals. The difference is a price difference. */
  "COMPARABLE",
  /** Real overlap, and a named scope difference that accounts for part of the gap. */
  "SCOPE_DIFFERS",
  /** The two documents do not describe enough of the same work to be compared. */
  "NOT_COMPARABLE",
]);
export type ComparisonVerdict = z.infer<typeof ComparisonVerdictSchema>;

export const ComparisonSchema = z.object({
  caseId: z.string(),
  quoteAId: z.string(),
  quoteBId: z.string(),
  verdict: ComparisonVerdictSchema,
  alignments: z.array(AlignmentSchema),
  coverage: z.object({
    shared: z.number().int().nonnegative(),
    onlyA: z.number().int().nonnegative(),
    onlyB: z.number().int().nonnegative(),
    /** Jaccard over work keys: shared / (shared + onlyA + onlyB). */
    overlap: z.number().min(0).max(1),
  }),
  totals: z.object({
    a: CentsSchema,
    b: CentsSchema,
    difference: CentsSchema,
  }),
  attribution: AttributionSchema,
  /** Line-item ids whose text the normaliser declined to map, by quote. */
  unmapped: z.object({
    a: z.array(z.string()).default([]),
    b: z.array(z.string()).default([]),
  }),
  /** The single largest scope difference, if there is one worth naming. */
  headline: z
    .object({
      component: ComponentIdSchema,
      label: z.string(),
      presentIn: z.enum(["A", "B"]),
      amountCents: CentsSchema.optional(),
    })
    .optional(),
  generatedAt: z.string(),
});
export type Comparison = z.infer<typeof ComparisonSchema>;
