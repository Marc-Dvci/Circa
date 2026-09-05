import { z } from "zod";

/**
 * The verification vocabulary.
 *
 * There is no score in here, and there is no probability. A product that tells a
 * homeowner something about the person standing in their kitchen has to be able
 * to say exactly what it observed and exactly where the expectation comes from,
 * because the alternative is an unfalsifiable number attached to a named
 * business. Every check is a named rule over recorded facts, and every rule
 * carries the published guidance it implements.
 */

export const CheckStatusSchema = z.enum([
  /** The condition was checked and is satisfied. */
  "CLEAR",
  /** Something objectively absent from the record. Not an accusation: an unanswered question. */
  "VERIFY",
  /** A decision condition that published consumer guidance names. Still not an accusation. */
  "ATTENTION",
  /** The rule does not apply to this case. Reported, not hidden, so the checklist length is stable. */
  "NOT_APPLICABLE",
]);
export type CheckStatus = z.infer<typeof CheckStatusSchema>;

export const CheckDimensionSchema = z.enum([
  "IDENTITY",
  "PROPOSAL",
  "DECISION_CONDITIONS",
  "INDEPENDENT_EVIDENCE",
]);
export type CheckDimension = z.infer<typeof CheckDimensionSchema>;

/**
 * Where the expectation comes from. `CIRCA_POLICY` is allowed but has to say so:
 * a rule with no external basis is a product opinion and is labelled as one.
 */
export const BasisSchema = z.object({
  source: z.enum(["FTC", "AARP", "CIRCA_POLICY"]),
  reference: z.string(),
  url: z.string().url().optional(),
});
export type Basis = z.infer<typeof BasisSchema>;

export const VerificationCheckSchema = z.object({
  ruleId: z.string(),
  dimension: CheckDimensionSchema,
  status: CheckStatusSchema,
  /**
   * What was observed, in the second person, about the transaction. Never about
   * the person. `assertSafeLanguage` in this package is the enforcement.
   */
  statement: z.string(),
  basis: BasisSchema,
  /** Case facts the rule read. Lets a user ask "why did you say that". */
  evidence: z.array(z.string()).default([]),
  nextStep: z.string().optional(),
});
export type VerificationCheck = z.infer<typeof VerificationCheckSchema>;

export const VerificationReportSchema = z.object({
  caseId: z.string(),
  checks: z.array(VerificationCheckSchema),
  counts: z.object({
    clear: z.number().int().nonnegative(),
    verify: z.number().int().nonnegative(),
    attention: z.number().int().nonnegative(),
    notApplicable: z.number().int().nonnegative(),
  }),
  /** "5 of 9 checks complete" — the applicable ones that are CLEAR. */
  completedApplicable: z.number().int().nonnegative(),
  totalApplicable: z.number().int().nonnegative(),
  generatedAt: z.string(),
});
export type VerificationReport = z.infer<typeof VerificationReportSchema>;

/**
 * Language the product may never emit.
 *
 * This is a schema-level guard rather than a prompt instruction because it has
 * to hold for the deterministic strings too, and because a guard that lives in a
 * system prompt is a guard that a document can argue with. Every rule statement
 * and every generated sentence passes through `assertSafeLanguage`, and the
 * suite drives it into the failing state on purpose.
 */
const FORBIDDEN: readonly { pattern: RegExp; why: string }[] = [
  { pattern: /\bscam(mer|ming)?\b/i, why: "accuses a party of a crime" },
  { pattern: /\bfraud(ulent|ster)?\b/i, why: "accuses a party of a crime" },
  { pattern: /\bcon (artist|man)\b/i, why: "accuses a party of a crime" },
  { pattern: /\bripping you off\b/i, why: "accuses a party of dishonesty" },
  { pattern: /\bdishonest\b/i, why: "characterises a party rather than the transaction" },
  { pattern: /\bcrook(ed)?\b/i, why: "accuses a party of a crime" },
  { pattern: /\bsteal(ing)?\s+(your|from)\b/i, why: "accuses a party of a crime" },
  { pattern: /\bthey('| a)re trying to\b/i, why: "asserts intent" },
  { pattern: /\bprobably (unlicensed|uninsured|lying)\b/i, why: "asserts an unverified fact as likely" },
  { pattern: /\bfair market price\b/i, why: "claims an authority over price the data does not support" },
  { pattern: /\bthis should cost\b/i, why: "states a price CIRCA has not observed" },
  { pattern: /\bdon'?t trust\b/i, why: "issues a trust verdict" },
  { pattern: /\btrustworthy\b/i, why: "issues a trust verdict" },
];

export class UnsafeLanguageError extends Error {
  constructor(
    readonly text: string,
    readonly matched: string,
    readonly why: string,
  ) {
    super(`unsafe language (${why}): "${matched}" in ${JSON.stringify(text.slice(0, 200))}`);
    this.name = "UnsafeLanguageError";
  }
}

/**
 * `allowNegated` exists for one real sentence the product does say, and says
 * deliberately: "I can't tell you whether this contractor is trustworthy."
 * Denying a trust verdict is the opposite of issuing one, so the guard takes an
 * explicit exemption list rather than a looser regex that a generated sentence
 * could drift through.
 */
const NEGATED_EXEMPTIONS: readonly RegExp[] = [
  /\b(can'?t|cannot|can not|won'?t|will not|don'?t|do not|no way to)\b[^.?!]{0,60}\btrustworthy\b/i,
  /\bnot (a|an) (?:judgement|judgment|verdict) (?:about|on) (?:trust|honesty)\b/i,
];

export function findUnsafeLanguage(text: string): { matched: string; why: string } | null {
  for (const exemption of NEGATED_EXEMPTIONS) {
    if (exemption.test(text)) return null;
  }
  for (const { pattern, why } of FORBIDDEN) {
    const m = pattern.exec(text);
    if (m) return { matched: m[0], why };
  }
  return null;
}

export function assertSafeLanguage(text: string): string {
  const hit = findUnsafeLanguage(text);
  if (hit) throw new UnsafeLanguageError(text, hit.matched, hit.why);
  return text;
}
