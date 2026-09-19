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
  // "Tota1": a scanned "l" read as a one.
  /^\s*(?:grand\s+)?tota[l1](?:\s+due)?(?:\s+price)?\s*[:\-]?\s*(.+)$/i,
  // An insurance adjuster's estimate: the price of the work before depreciation.
  /^\s*replacement\s+cost\s+value(?:\s*\(rcv\))?\s*[:\-]?\s*(.+)$/i,
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
  /^\s*(?:observed|observations?|findings?|notes?|comments?|remarks?|conditions?|assumptions?|terms?|scope(?: of work)?|summary|recommendation)\s*[:\-]/i,
  /^\s*(?:not inspected|unable to inspect|limitations?)\s*[:\-]/i,
  /^\s*(?:reason|loss|job|subject|re|customer chose|prepared for|bill to|ship to|approved by)\s*:/i,
];

/**
 * A line that is the document's own name for itself: "ESTIMATE #1047",
 * "Change Order #2 - Contract 2026-114", "Estimate - Blue Crane Plumbing -
 * whole-house repipe". Only when it carries no amount; a line with money on it
 * is a line item whatever it is called.
 */
const TITLE_WORDS =
  /\b(?:estimate|quote|quotation|proposal|invoice|agreement|contract|work order|service ticket|change order|presupuesto)\b/i;

/**
 * A line that sums other lines: any "total" that is not the document's total
 * ("Option A Total", "Change order total", "Line Item Totals"), plus the summary
 * rows an adjuster's estimate carries. Never a line item; the first one stands
 * in for the document total when no plain "Total" line exists.
 */
const SUMMARY_WORDS = /\btotals?\b|\bsub\s*total\b|\bbalance\s+(?:due|forward)\b|\bnet\s+claim\b|\bdepreciation\b/i;
function isSummaryLine(line: string): boolean {
  const { text } = trailingAmount(line);
  return SUMMARY_WORDS.test(text) && text.trim().split(/\s+/).length <= 5;
}

/**
 * The total stated mid-sentence: "for the total sum of Twelve Thousand Four
 * Hundred Dollars ($12,400.00)", "Customer chose: repair. Total due today $474."
 */
const TOTAL_IN_PROSE =
  /\b(?:total\s+(?:sum|due|price|cost|amount)|all\s+in)\b[^$£€]{0,80}?[$£€]\s*([0-9][0-9,]*(?:\.[0-9]{2})?)/i;

/** "A deposit of $3,000.00 is due at signing." */
const DEPOSIT_IN_PROSE = /\bdeposit\s+of\s+[$£€]\s*([0-9][0-9,]*(?:\.[0-9]{2})?)/i;

/** Tax on a quote is money, and it is never work. */
const TAX_LINE = /\b(?:sales\s+)?tax\b|\bvat\b|\bgst\b|\bhst\b|\bpst\b/i;

/**
 * An alternate, an add-on, an option other than the one proposed: priced on the
 * page and outside the total. "Option A (recommended)" is the proposal; "Option
 * B", "Alternate", "Add-on" and "Replacement option" are not, and a header of
 * that kind scopes the lines under it until the next blank line or header.
 */
const OPTIONAL_PREFIX =
  /^\s*(?:option\s+(?:[b-z]|[2-9])\b|alternates?\b|alt\.?\s|add-?ons?\b|optional\b|upgrade\s+option\b|replacement\s+option\b|options?\s+(?:[b-z]|[2-9])?\s*[:\-]|(?:repair|replacement|alternate|upgrade)\s+options?\s*:)/i;
const OPTIONAL_HEADER = /^\s*(?:replacement|upgrade|alternate|alternative|optional|add-?on)s?\s+options?\s*:?\s*$|^\s*options?\s+(?:[b-z]|[2-9])\b.*:\s*$/i;
const WAIVED = /\bwaived\b|\bno\s+charge\b|\bn\/c\b/i;

/**
 * A row of a pipe table, as a quote pasted from a web portal or a Markdown
 * document arrives: cells between bars, emphasis marks around the total.
 */
function unpipe(line: string): string {
  if (!/^\s*\|/.test(line)) return line;
  return line
    .split("|")
    .map((cell) => cell.replace(/\*\*/g, "").trim())
    .filter((cell) => cell.length > 0)
    .join("  ");
}

/**
 * Join a description that wraps onto the next line, as scanned and photographed
 * estimates do: the amount sits on the last line and the first line has no
 * money. The join is taken only when the continuation starts in lower case,
 * which is how a wrapped clause reads and how a new item does not.
 */
function joinWrapped(lines: string[]): { text: string; endsAt: number }[] {
  const out: { text: string; endsAt: number }[] = [];
  let i = 0;
  while (i < lines.length) {
    let text = lines[i]!;
    let end = i;
    while (
      end + 1 < lines.length &&
      trailingAmount(text).amount === undefined &&
      text.trim().length > 0 &&
      !isSummaryLine(text) &&
      !ANNOTATION_PATTERNS.some((p) => p.test(text)) &&
      /^\s*[a-z]/.test(lines[end + 1]!) &&
      !/^\s*(?:[-*•–]|\d+[.)])\s*/.test(lines[end + 1]!) &&
      // A line wraps because it ended on a connector, or because the next
      // line is where its amount is. A line ending on a full word, followed by
      // another unpriced line, is a line of its own.
      (/(?:,|\band\b|\bwith\b|\bor\b|\bof\b|\bfor\b|\bto\b|\bnew\b|\bincl\.?|\bthe\b|\ba\b|\ban\b|\bplus\b|\bat\b|\bin\b|\bon\b)\s*$/i.test(text) ||
        trailingAmount(lines[end + 1]!).amount !== undefined)
    ) {
      end += 1;
      text = `${text.trim()} ${lines[end]!.trim()}`;
    }
    out.push({ text, endsAt: end });
    i = end + 1;
  }
  return out;
}

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
  // "$850.00", "£ 640.00", "-$50.00", "($ 60.00)" as a credit, and the bare
  // "1,468.80" an adjuster's estimate or a spreadsheet export prints with no
  // sign at all. A bare number needs its two decimals; "8 rolls" is a quantity.
  const match =
    /^(.*?)[\s.…]*(\(\s*[$£€]\s*[0-9][0-9,]*(?:\.[0-9]{2})?\s*\)|-?\s*[$£€]\s*[0-9][0-9,]*(?:\.[0-9]{2})?|-?[0-9]{1,3}(?:,[0-9]{3})*\.[0-9]{2}|-?[0-9]+\.[0-9]{2})\s*$/.exec(
      line,
    );
  if (match) {
    const token = match[2]!;
    const negative = token.startsWith("(") || token.startsWith("-");
    const amount = parseCents(token.replace(/[()£€-]/g, ""));
    if (amount !== null) return { text: match[1]!.trim(), amount: negative ? -amount : amount };
  }
  // "$285 - replace dual run capacitor": the amount leads the line.
  const leading = /^\s*([$£€]\s*[0-9][0-9,]*(?:\.[0-9]{2})?)\s*(?:[-–—:]|\.{2,})\s*(.+)$/.exec(line);
  if (leading) {
    const amount = parseCents(leading[1]!.replace(/[£€]/g, ""));
    if (amount !== null) return { text: leading[2]!.trim(), amount };
  }
  return { text: line };
}

function kindFor(text: string): LineItemKind {
  for (const [pattern, kind] of KIND_HINTS) if (pattern.test(text)) return kind;
  return "UNKNOWN";
}

export function parseQuoteText(input: ParseQuoteInput): Quote {
  const capturedAt = input.capturedAt ?? new Date().toISOString();
  const rawLines = input.text.split(/\r?\n/);
  const physical = joinWrapped(rawLines.map(unpipe));
  const lineItems: LineItem[] = [];
  let summaryTotal: number | undefined;
  let proseTotal: number | undefined;
  let optionalSection = false;
  const exclusions: string[] = [];
  const paymentMethods = new Set<PaymentMethod>();
  let total: number | undefined;
  let deposit: number | undefined;
  let warranty: string | undefined;
  let startDate: string | undefined;
  let completionDate: string | undefined;
  let concealedDamageClause = false;

  physical.forEach(({ text: rawLine, endsAt }) => {
    // The line the money is on, which for a wrapped description is the last.
    const index = endsAt;
    const line = rawLine.trim();
    if (!line) {
      optionalSection = false;
      return;
    }
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
        // "Deposit required: 50% ($4,642.50)": the amount, not the percentage.
        const money = /[$£€]\s*[0-9][0-9,]*(?:\.[0-9]{2})?/.exec(m[1]!);
        const value = money ? parseCents(money[0].replace(/[£€]/g, "")) : /%/.test(m[1]!) ? null : parseCents(m[1]!);
        if (value !== null) deposit = value;
        return;
      }
    }
    if (deposit === undefined) {
      const m = DEPOSIT_IN_PROSE.exec(line);
      if (m) {
        const value = parseCents(m[1]!);
        if (value !== null) deposit = value;
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
    if (isSummaryLine(line)) {
      const { amount } = trailingAmount(line);
      if (amount !== undefined && summaryTotal === undefined && /\btotals?\b/i.test(line)) summaryTotal = amount;
      return;
    }
    if (proseTotal === undefined) {
      const m = TOTAL_IN_PROSE.exec(line);
      if (m) {
        const value = parseCents(m[1]!);
        if (value !== null) proseTotal = value;
      }
    }
    // Option sections: a header opens one, a blank line or the next header closes it.
    if (OPTIONAL_HEADER.test(line)) {
      optionalSection = true;
      return;
    }
    if (/^\s*option\s+(?:a|1)\b/i.test(line) || (/:\s*$/.test(line) && trailingAmount(line).amount === undefined)) optionalSection = false;
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
    const optional = optionalSection || OPTIONAL_PREFIX.test(stripped);
    let { text, amount } = trailingAmount(stripped);
    // "diagnostic fee (waived with repair)": the money is on the page and not
    // in the total.
    if (amount !== undefined && WAIVED.test(text)) amount = undefined;

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
      if (TITLE_WORDS.test(text)) return;
      // A table's column headings: "Qty  Description  Rate  Amount".
      if (/^(?:#|no\.?|item|qty|quantity|description|unit|uom|rate|unit price|price|amount|total|rcv|acv)(?:\s+(?:#|no\.?|item|qty|quantity|description|unit|uom|rate|unit price|price|amount|total|rcv|acv|\([a-z]{3}\)))*$/i.test(text.replace(/\s+/g, " ").trim())) return;
    }
    const body = text.replace(/^\s*(?:[-*•–])\s*/, "").trim();
    if (!body) return;

    const normalised = normaliseLineItem(body, input.trade, input.defaultAction ?? "UNKNOWN");
    for (const excludedId of normalised.excluded) {
      if (!exclusions.includes(body)) exclusions.push(body);
      void excludedId;
    }
    // A credit proposes no work; it takes money off work proposed elsewhere.
    // Tax is the same: "Sales tax (materials)" is not a line of materials.
    const credit = (amount !== undefined && amount < 0) || TAX_LINE.test(body);
    const item: LineItem = {
      id: `${input.id}-li${lineItems.length + 1}`,
      raw: body,
      kind: optional ? "OPTIONAL" : kindFor(body),
      work: credit ? [] : normalised.work,
      evidence: { documentId: input.documentId, line: index + 1, excerpt: rawLine.slice(0, 2000) },
    };
    if (amount !== undefined) item.amount = amount;
    lineItems.push(item);
  });

  // A quote with no stated total is the sum of what it does state. Reported as
  // such by itemisation, which will read coverage 1.0 and level ITEMISED.
  const resolvedTotal =
    total ??
    proseTotal ??
    summaryTotal ??
    lineItems.filter((li) => li.kind !== "OPTIONAL").reduce((sum, li) => sum + (li.amount ?? 0), 0);

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
