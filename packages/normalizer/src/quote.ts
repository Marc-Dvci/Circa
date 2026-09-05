import type { LineItem, LineItemKind, PaymentMethod, Quote, Trade, WorkAction } from "#schema";
import { computeItemisation, parseCents } from "#schema";
import { normaliseLineItem } from "./lineitem.js";

/**
 * Turn the text of a quote into a `Quote`.
 *
 * Deterministic. It reads line items, amounts, exclusions, a total, a deposit
 * and a payment schedule out of plain text, and it does so without a model,
 * because the extraction is where a document gets to lie: everything downstream
 * treats the parsed object as fact, so the parser is the trust boundary and it
 * is code, not a prompt.
 *
 * `packages/documents` puts Textract and Bedrock in front of this for the cases
 * plain text cannot handle — a photograph of a handwritten estimate — and then
 * hands the result back through here so the same rules apply.
 */

export interface ParseQuoteInput {
  id: string;
  caseId: string;
  text: string;
  trade: Trade;
  source: Quote["source"];
  contractorName?: string;
  documentId?: string;
  capturedAt?: string;
  /** What a bare component name means in this document. Quotes usually mean REPLACE. */
  defaultAction?: WorkAction;
}

const TOTAL_PATTERNS: readonly RegExp[] = [
  /^\s*(?:grand\s+)?total(?:\s+due)?(?:\s+price)?\s*[:\-]?\s*(.+)$/i,
  /^\s*contract\s+(?:price|amount)\s*[:\-]?\s*(.+)$/i,
  /^\s*(?:project|job)\s+total\s*[:\-]?\s*(.+)$/i,
];
const DEPOSIT_PATTERNS: readonly RegExp[] = [
  /^\s*deposit(?:\s+required|\s+due)?\s*[:\-]?\s*(.+)$/i,
  /^\s*down\s*payment\s*[:\-]?\s*(.+)$/i,
  /^\s*(?:payment\s+)?up\s*front\s*[:\-]?\s*(.+)$/i,
];
const EXCLUSION_PATTERNS: readonly RegExp[] = [
  /^\s*(?:exclusions?|not included|excludes?)\s*[:\-]?\s*(.+)$/i,
];
const SUBTOTAL_PATTERNS: readonly RegExp[] = [/^\s*(?:sub\s*total|subtotal)\s*[:\-]?/i];

/**
 * Labelled prose. Everything after one of these prefixes describes the job
 * rather than pricing part of it, and only a labelled line qualifies — an
 * unlabelled sentence in the middle of a quote is still scope.
 */
const ANNOTATION_PATTERNS: readonly RegExp[] = [
  /^\s*(?:observed|observations?|findings?|notes?|comments?|remarks?|conditions?|assumptions?|terms?|scope of work|summary|recommendation)\s*[:\-]/i,
  /^\s*(?:not inspected|unable to inspect|limitations?)\s*[:\-]/i,
];

const KIND_HINTS: readonly (readonly [RegExp, LineItemKind])[] = [
  [/\blabou?r\b|\bman.?hours?\b|\bcrew\b/i, "LABOR"],
  [/\bmaterials?\b|\bsupplies\b/i, "MATERIAL"],
  [/\bpermit\b|\bfee\b|\bdumpster\b|\btrip charge\b|\bservice call\b/i, "FEE"],
  [/\ballowance\b|\bbudget(?:ed)? for\b|\bif required\b|\bif needed\b/i, "ALLOWANCE"],
];

const PAYMENT_HINTS: readonly (readonly [RegExp, PaymentMethod])[] = [
  [/\bcash only\b|\bcash\b/i, "CASH"],
  [/\bwire (?:transfer)?\b|\bzelle\b|\bbank transfer\b/i, "WIRE"],
  [/\bche(?:ck|que)\b/i, "CHECK"],
  [/\b(?:credit|debit) card\b|\bvisa\b|\bmastercard\b/i, "CARD"],
  [/\bach\b|\bdirect debit\b/i, "ACH"],
  [/\bfinancing (?:available|through us)\b|\bwe finance\b|\bin.?house financing\b/i, "CONTRACTOR_FINANCING"],
];

const CONCEALED_CLAUSE =
  /\b(?:concealed|hidden|unforeseen|latent|pre.?existing)\s+(?:damage|condition|conditions|defect)/i;

/**
 * A trailing amount on a line: "…flashing …………… $850.00".
 *
 * `\$\s*` rather than `\$\s?`, because quotes right-align their amounts and a
 * padded `$  400.00` is the common case, not the exception. With a single
 * optional space the amount silently vanished, the line item survived without
 * one, and the only visible symptom was a quote's attribution coverage quietly
 * dropping below the threshold that decides whether a comparison is reportable.
 */
function trailingAmount(line: string): { text: string; amount?: number } {
  const match = /^(.*?)[\s.…]*(\$\s*[0-9][0-9,]*(?:\.[0-9]{2})?)\s*$/.exec(line);
  if (!match) return { text: line };
  const amount = parseCents(match[2]!);
  if (amount === null) return { text: line };
  return { text: match[1]!.trim(), amount };
}

function kindFor(text: string): LineItemKind {
  for (const [pattern, kind] of KIND_HINTS) if (pattern.test(text)) return kind;
  return "UNKNOWN";
}

export function parseQuoteText(input: ParseQuoteInput): Quote {
  const capturedAt = input.capturedAt ?? new Date().toISOString();
  const rawLines = input.text.split(/\r?\n/);
  const lineItems: LineItem[] = [];
  const exclusions: string[] = [];
  const paymentMethods = new Set<PaymentMethod>();
  let total: number | undefined;
  let deposit: number | undefined;
  let warranty: string | undefined;
  let startDate: string | undefined;
  let completionDate: string | undefined;
  let concealedDamageClause = false;

  rawLines.forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line) return;
    if (CONCEALED_CLAUSE.test(line)) concealedDamageClause = true;
    for (const [pattern, method] of PAYMENT_HINTS) if (pattern.test(line)) paymentMethods.add(method);

    for (const pattern of TOTAL_PATTERNS) {
      const m = pattern.exec(line);
      if (m) {
        const value = parseCents(m[1]!);
        if (value !== null) total = value;
        return;
      }
    }
    for (const pattern of DEPOSIT_PATTERNS) {
      const m = pattern.exec(line);
      if (m) {
        const value = parseCents(m[1]!);
        if (value !== null) deposit = value;
        return;
      }
    }
    for (const pattern of EXCLUSION_PATTERNS) {
      const m = pattern.exec(line);
      if (m) {
        for (const part of m[1]!.split(/[;,]/)) {
          const clean = part.trim();
          if (clean) exclusions.push(clean);
        }
        return;
      }
    }
    if (SUBTOTAL_PATTERNS.some((p) => p.test(line))) return;
    if (/^\s*warranty\s*[:\-]/i.test(line)) {
      warranty = line.replace(/^\s*warranty\s*[:\-]\s*/i, "").trim();
      return;
    }
    if (/^\s*start(?:\s+date)?\s*[:\-]/i.test(line)) {
      startDate = line.replace(/^\s*start(?:\s+date)?\s*[:\-]\s*/i, "").trim();
      return;
    }
    if (/^\s*(?:completion|finish|end)(?:\s+date)?\s*[:\-]/i.test(line)) {
      completionDate = line.replace(/^\s*(?:completion|finish|end)(?:\s+date)?\s*[:\-]\s*/i, "").trim();
      return;
    }
    // Headers and addresses are not line items.
    if (/^[-=_*\s]+$/.test(line)) return;
    // Nor are the document's own notes.
    //
    // "Observed: no moisture in the decking below on thermal survey" is a
    // finding, and it was becoming an unpriced inspection line on the assessor's
    // quote. One unpriced non-shared unit is enough to make a whole comparison
    // unattributable, so a report that carefully wrote down what it did *not*
    // find was punished for it: the second comparison in the demo refused for a
    // reason that had nothing to do with either price. A prefixed annotation is
    // metadata; the money is on the lines without one.
    if (ANNOTATION_PATTERNS.some((p) => p.test(line))) return;
    if (/^\s*(?:quote|estimate|proposal|invoice|prepared for|prepared by|date|phone|email|address|licence|license)\s*[:#]/i.test(line))
      return;

    const stripped = line.replace(/^\s*(?:[-*•–]|\d+[.)])\s*/, "");
    const { text, amount } = trailingAmount(stripped);

    // A letterhead is not scope.
    //
    // Trades name themselves after what they do, so the first line of almost
    // every estimate contains a lexeme: "Nine Elms Exterior Surveys" produced an
    // unpriced inspection unit, and one unpriced non-shared unit is enough to
    // make an entire comparison unattributable. The assessor's own name was
    // therefore deciding whether two quotes could be compared. Two shapes are
    // skipped, both only when the line carries no amount: a line containing the
    // business name we were given, and a line in capitals. A line with money on
    // it is a line item whatever it looks like.
    if (amount === undefined) {
      const name = input.contractorName;
      if (name && name.length >= 4 && text.toLowerCase().includes(name.toLowerCase())) return;
      const letters = text.replace(/[^A-Za-z]/g, "");
      if (letters.length >= 6 && letters === letters.toUpperCase()) return;
    }
    const body = text.replace(/^\s*(?:[-*•–])\s*/, "").trim();
    if (!body) return;

    const normalised = normaliseLineItem(body, input.trade, input.defaultAction ?? "UNKNOWN");
    for (const excludedId of normalised.excluded) {
      if (!exclusions.includes(body)) exclusions.push(body);
      void excludedId;
    }
    const item: LineItem = {
      id: `${input.id}-li${lineItems.length + 1}`,
      raw: body,
      kind: kindFor(body),
      work: normalised.work,
      evidence: { documentId: input.documentId, line: index + 1, excerpt: rawLine.slice(0, 2000) },
    };
    if (amount !== undefined) item.amount = amount;
    lineItems.push(item);
  });

  // A quote with no stated total is the sum of what it does state. Reported as
  // such by itemisation, which will read coverage 1.0 and level ITEMISED.
  const resolvedTotal = total ?? lineItems.reduce((sum, li) => sum + (li.amount ?? 0), 0);

  const quote: Quote = {
    id: input.id,
    caseId: input.caseId,
    source: input.source,
    currency: "USD",
    total: resolvedTotal,
    lineItems,
    exclusions,
    paymentSchedule: [],
    paymentMethods: [...paymentMethods],
    written: true,
    concealedDamageClause,
    capturedAt,
  };
  if (input.contractorName) quote.contractorName = input.contractorName;
  if (deposit !== undefined) quote.deposit = deposit;
  if (warranty) quote.warranty = warranty;
  if (startDate) quote.startDate = startDate;
  if (completionDate) quote.completionDate = completionDate;
  quote.itemisation = computeItemisation(quote);
  return quote;
}

/**
 * A quote captured by voice: one number, one paragraph, no document.
 *
 * This is the common case and the reason the itemisation field exists. The
 * result is deliberately a single unpriced line item, so `computeItemisation`
 * reports coverage 0 and every downstream comparison correctly refuses to
 * attribute the money.
 */
export function quoteFromSpokenOffer(input: {
  id: string;
  caseId: string;
  description: string;
  total: number;
  trade: Trade;
  contractorName?: string;
  deposit?: number;
  capturedAt?: string;
}): Quote {
  const normalised = normaliseLineItem(input.description, input.trade, "UNKNOWN");
  const quote: Quote = {
    id: input.id,
    caseId: input.caseId,
    source: "CONTRACTOR",
    currency: "USD",
    total: input.total,
    lineItems: [
      {
        id: `${input.id}-li1`,
        raw: input.description,
        kind: "UNKNOWN",
        work: normalised.work,
        evidence: { excerpt: input.description.slice(0, 2000) },
      },
    ],
    exclusions: [],
    paymentSchedule: [],
    paymentMethods: [],
    written: false,
    capturedAt: input.capturedAt ?? new Date().toISOString(),
  };
  if (input.contractorName) quote.contractorName = input.contractorName;
  if (input.deposit !== undefined) quote.deposit = input.deposit;
  quote.itemisation = computeItemisation(quote);
  return quote;
}
