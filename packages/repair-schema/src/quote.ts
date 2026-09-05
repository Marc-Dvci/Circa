import { z } from "zod";
import { WorkUnitSchema } from "./work.js";

/**
 * A quote, as it actually arrives.
 *
 * The single most important field here is `itemisation`. Most residential
 * quotes are one number for a paragraph of work, and every product that
 * compares "the price" of two of them is quietly asserting an attribution that
 * the document does not contain. This schema makes the attribution explicit and
 * refusable.
 */

export const CentsSchema = z.number().int();

export const LineItemKindSchema = z.enum([
  "LABOR",
  "MATERIAL",
  "COMBINED",
  "FEE", // permit, dump, trip
  "ALLOWANCE", // a placeholder budget, not a priced commitment
  "UNKNOWN",
]);
export type LineItemKind = z.infer<typeof LineItemKindSchema>;

/**
 * Where a claim came from, so every number on screen can be traced back to the
 * place in the document it was read out of. A user must be able to ask "where
 * did you get that" and receive a page and a line, not a paraphrase.
 */
export const EvidenceRefSchema = z.object({
  documentId: z.string().optional(),
  page: z.number().int().positive().optional(),
  line: z.number().int().nonnegative().optional(),
  /** Verbatim source text. Untrusted: never interpolated into a model prompt as instructions. */
  excerpt: z.string().max(2000).optional(),
});
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

export const LineItemSchema = z.object({
  id: z.string(),
  /** Verbatim text from the document or the spoken description. Untrusted input. */
  raw: z.string(),
  amount: CentsSchema.optional(),
  quantity: z.number().positive().optional(),
  kind: LineItemKindSchema.default("UNKNOWN"),
  /** Normalised work. Empty means the normaliser declined to map it, which is a reportable state. */
  work: z.array(WorkUnitSchema).default([]),
  evidence: EvidenceRefSchema.optional(),
});
export type LineItem = z.infer<typeof LineItemSchema>;

export const ItemisationLevelSchema = z.enum(["ITEMISED", "PARTIAL", "LUMP_SUM"]);
export type ItemisationLevel = z.infer<typeof ItemisationLevelSchema>;

export const ItemisationSchema = z.object({
  level: ItemisationLevelSchema,
  /** Sum of line-item amounts that carry one. */
  attributedCents: CentsSchema,
  totalCents: CentsSchema,
  /** attributedCents / totalCents, clamped to [0,1]. */
  coverage: z.number().min(0).max(1),
  /** Line items that describe work but carry no amount. */
  unpricedItems: z.number().int().nonnegative(),
});
export type Itemisation = z.infer<typeof ItemisationSchema>;

export const PaymentMilestoneSchema = z.object({
  label: z.string(),
  amount: CentsSchema.optional(),
  fraction: z.number().min(0).max(1).optional(),
  dueAt: z.string().optional(),
});
export type PaymentMilestone = z.infer<typeof PaymentMilestoneSchema>;

export const PaymentMethodSchema = z.enum([
  "CASH",
  "CHECK",
  "CARD",
  "WIRE",
  "ACH",
  "CONTRACTOR_FINANCING",
  "UNSPECIFIED",
]);
export type PaymentMethod = z.infer<typeof PaymentMethodSchema>;

export const QuoteSourceSchema = z.enum([
  "CONTRACTOR", // the offer the customer was given
  "SECOND_OPINION", // an independent assessment CIRCA requested
  "MARKETPLACE", // a listed provider's own estimate
  "REFERENCE", // a seeded regional reference figure, never a prediction
]);
export type QuoteSource = z.infer<typeof QuoteSourceSchema>;

export const QuoteSchema = z.object({
  id: z.string(),
  caseId: z.string(),
  source: QuoteSourceSchema,
  contractorName: z.string().optional(),
  contractorId: z.string().optional(),
  currency: z.literal("USD").default("USD"),
  total: CentsSchema,
  deposit: CentsSchema.optional(),
  lineItems: z.array(LineItemSchema).default([]),
  /** Verbatim exclusions. "Does not include decking" is worth more than most line items. */
  exclusions: z.array(z.string()).default([]),
  warranty: z.string().optional(),
  startDate: z.string().optional(),
  completionDate: z.string().optional(),
  paymentSchedule: z.array(PaymentMilestoneSchema).default([]),
  paymentMethods: z.array(PaymentMethodSchema).default([]),
  /** True when the document says concealed or unforeseen conditions may change the price. */
  concealedDamageClause: z.boolean().optional(),
  written: z.boolean().default(false),
  itemisation: ItemisationSchema.optional(),
  capturedAt: z.string(),
});
export type Quote = z.infer<typeof QuoteSchema>;

/**
 * Compute itemisation from the line items.
 *
 * ITEMISED requires 90% of the total to be attributed to priced line items;
 * below 40% the quote is a lump sum whatever it looks like. The two thresholds
 * are the only numbers in this package that are policy rather than arithmetic,
 * and both are stated in `docs/model.md` with the reason.
 */
export const ITEMISED_COVERAGE = 0.9;
export const LUMP_SUM_COVERAGE = 0.4;

export function computeItemisation(quote: Pick<Quote, "total" | "lineItems">): Itemisation {
  const priced = quote.lineItems.filter((li) => typeof li.amount === "number");
  const attributedCents = priced.reduce((sum, li) => sum + (li.amount ?? 0), 0);
  const totalCents = quote.total;
  const coverage = totalCents === 0 ? 0 : Math.min(1, Math.max(0, attributedCents / totalCents));
  const level: ItemisationLevel =
    coverage >= ITEMISED_COVERAGE ? "ITEMISED" : coverage >= LUMP_SUM_COVERAGE ? "PARTIAL" : "LUMP_SUM";
  return {
    level,
    attributedCents,
    totalCents,
    coverage,
    unpricedItems: quote.lineItems.length - priced.length,
  };
}
