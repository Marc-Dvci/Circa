import type { LineItem, Quote, Trade, WorkUnit } from "#schema";
import { computeItemisation, parseCents } from "#schema";
import { normaliseLineItem } from "#normalizer";
import { workKey } from "#schema";
import type { IsolatedDocument } from "./isolate.js";

/**
 * Grounding: a model may propose, and it may not invent.
 *
 * A language model reading a photographed estimate is genuinely useful — it
 * copes with two-column layouts, wrapped lines and handwriting in a way a regex
 * does not. It is also the one component in the system with an incentive to be
 * helpful about missing information, and "helpful about missing information" on
 * a five-figure repair decision means a line item nobody wrote.
 *
 * So every proposed line item is checked back against the document twice. Its
 * text must appear in the document (normalised for whitespace and case, because
 * an extractor rewraps lines). Its work units must be the ones
 * `normaliseLineItem` derives from that text — the model's own component
 * assignments are discarded, not merged. What survives is a structure the model
 * found and the deterministic engine agrees with; what does not survive is
 * reported, because a proposal rejected in silence is a bug that never surfaces.
 */

export interface ProposedLineItem {
  raw: string;
  amount?: number | string;
  /** The model's proposed work. Recorded for the audit, then discarded. */
  work?: { component: string; action: string }[];
}

export interface ProposedQuote {
  contractorName?: string;
  total?: number | string;
  deposit?: number | string;
  lineItems?: ProposedLineItem[];
  exclusions?: string[];
}

export interface RejectedProposal {
  raw: string;
  reason: "TEXT_NOT_IN_DOCUMENT" | "AMOUNT_NOT_IN_DOCUMENT" | "NO_WORK_DERIVED";
}

export interface GroundingResult {
  lineItems: LineItem[];
  exclusions: string[];
  total?: number;
  deposit?: number;
  rejected: RejectedProposal[];
  /** Work units the model asserted that the normaliser did not derive. Dropped. */
  ungroundedWork: WorkUnit[];
}

/** Whitespace-insensitive, case-insensitive containment. Extractors rewrap; documents do not. */
function flatten(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function containsText(haystack: string, needle: string): boolean {
  const n = flatten(needle);
  if (n.length < 4) return false;
  return flatten(haystack).includes(n);
}

function toCents(value: number | string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : Math.round(value * 100);
  const parsed = parseCents(value);
  return parsed ?? undefined;
}

export function groundProposal(
  proposal: ProposedQuote,
  document: IsolatedDocument,
  trade: Trade,
  quoteId: string,
): GroundingResult {
  const source = document.untrustedText;
  const lineItems: LineItem[] = [];
  const rejected: RejectedProposal[] = [];
  const ungroundedWork: WorkUnit[] = [];

  (proposal.lineItems ?? []).forEach((item, index) => {
    if (!containsText(source, item.raw)) {
      rejected.push({ raw: item.raw, reason: "TEXT_NOT_IN_DOCUMENT" });
      return;
    }
    const amount = toCents(item.amount);
    // A price the document does not contain is the most damaging invention
    // available, so it is checked separately from the text it is attached to.
    if (amount !== undefined) {
      const dollars = Math.round(amount / 100);
      const forms = [dollars.toLocaleString("en-US"), String(dollars)];
      if (!forms.some((form) => source.includes(form))) {
        rejected.push({ raw: item.raw, reason: "AMOUNT_NOT_IN_DOCUMENT" });
        return;
      }
    }
    const normalised = normaliseLineItem(item.raw, trade, "REPLACE");
    if (normalised.work.length === 0 && normalised.excluded.length === 0) {
      rejected.push({ raw: item.raw, reason: "NO_WORK_DERIVED" });
      return;
    }
    const derived = new Set(normalised.work.map(workKey));
    for (const claimed of item.work ?? []) {
      const key = `${claimed.component}#${claimed.action}`;
      if (!derived.has(key)) {
        ungroundedWork.push({ component: claimed.component, action: claimed.action } as WorkUnit);
      }
    }
    const lineItem: LineItem = {
      id: `${quoteId}-li${index + 1}`,
      raw: item.raw,
      kind: "UNKNOWN",
      work: normalised.work,
      evidence: { documentId: document.id, excerpt: item.raw.slice(0, 2000) },
    };
    if (amount !== undefined) lineItem.amount = amount;
    lineItems.push(lineItem);
  });

  const exclusions = (proposal.exclusions ?? []).filter((e) => containsText(source, e));

  const result: GroundingResult = { lineItems, exclusions, rejected, ungroundedWork };
  const total = toCents(proposal.total);
  if (total !== undefined) result.total = total;
  const deposit = toCents(proposal.deposit);
  if (deposit !== undefined) result.deposit = deposit;
  return result;
}

/**
 * Assemble a grounded proposal into a `Quote`.
 *
 * The total falls back to the sum of the grounded line items, and never to the
 * model's figure when that figure is not in the document — a quote whose total
 * came from nowhere would flow straight into the comparison as the denominator
 * of every attribution.
 */
export function quoteFromGrounding(
  grounding: GroundingResult,
  input: { id: string; caseId: string; source: Quote["source"]; contractorName?: string; documentId: string; capturedAt: string },
): Quote {
  const summed = grounding.lineItems.reduce((sum, li) => sum + (li.amount ?? 0), 0);
  const quote: Quote = {
    id: input.id,
    caseId: input.caseId,
    source: input.source,
    currency: "USD",
    total: grounding.total ?? summed,
    lineItems: grounding.lineItems,
    exclusions: grounding.exclusions,
    paymentSchedule: [],
    paymentMethods: [],
    written: true,
    capturedAt: input.capturedAt,
  };
  if (input.contractorName) quote.contractorName = input.contractorName;
  if (grounding.deposit !== undefined) quote.deposit = grounding.deposit;
  quote.itemisation = computeItemisation(quote);
  return quote;
}
