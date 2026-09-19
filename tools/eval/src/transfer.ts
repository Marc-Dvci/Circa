import { parseQuoteText } from "#normalizer";
import type { ComponentId, Quote, Trade } from "#schema";
import { loadTransferDocuments, type TransferDocument, type TransferLine } from "./corpora.js";

/**
 * The transfer corpus: what the engine reads on documents it was not built on.
 *
 * The three regression corpora are a gate. This one was labelled first and read
 * second: 28 estimates in
 * the formats, regions and phrasings a product meets in the field, each priced
 * line labelled with the taxonomy ids a person would say it proposes, committed
 * before this file existed. The numbers are reported, never gated. A corpus
 * that must be green is a corpus that gets tuned.
 *
 * Four questions, in the order a customer would meet them:
 *
 * 1. Did the document's money get read? The total, and each priced line with
 *    its amount. A format the parser cannot read (amounts without a currency
 *    sign, amounts at the start of a line, a pipe table) fails here.
 * 2. On the lines it read, did the engine name the work the line proposes? A
 *    line counts as mapped only when every labelled component is present.
 * 3. Did it assert work the line does not propose? An alternate priced outside
 *    the total, an add-on, a summary line, or a component the document
 *    excludes, read as proposed work, is the failure a comparison cannot
 *    recover from, so it is counted separately and by money.
 * 4. How much of the labelled money describes work the taxonomy has no id for?
 *    That is the coverage ceiling of the lexicon, whatever the parser does.
 */

export interface TransferLineResult {
  line: number;
  excerpt: string;
  kind: TransferLine["kind"];
  amountCents: number;
  /** A line item with this line number and this amount exists. */
  read: boolean;
  /** Read, and counted toward the quote's proposed work rather than held out as an option. */
  readAsWork: boolean;
  /** Every labelled component is present. Only meaningful when `components` is non-empty. */
  mapped: boolean;
  missing: ComponentId[];
  /** Components asserted that the label neither names nor tolerates. */
  asserted: ComponentId[];
  outside: string[];
}

export interface TransferDocumentResult {
  id: string;
  title: string;
  trade: Trade;
  tags: string[];
  totalRead: boolean;
  totalCents: number;
  actualTotalCents: number;
  itemisationRead: boolean;
  actualItemisation: string;
  depositRead?: boolean;
  lines: TransferLineResult[];
  /** Document-level: labelled `proposes` against the union of positive work. */
  proposed: ComponentId[];
  found: ComponentId[];
  missed: ComponentId[];
  /** Asserted at document level, outside `proposes`, `tolerated` and every line's tolerance. */
  asserted: ComponentId[];
  /** Excluded by the document, asserted as work anyway. */
  excludedAsserted: ComponentId[];
  fullyRead: boolean;
}

export interface TransferReport {
  documents: number;
  /** Money and lines are counted over `work` lines: not tax, credit, summary, waived or alternate. */
  workLines: number;
  workCents: number;
  totalsRead: number;
  itemisationRead: number;
  linesRead: number;
  linesReadCents: number;
  /** Denominator: read work lines that label at least one in-taxonomy component. */
  mappable: number;
  mapped: number;
  mappedCents: number;
  mappableCents: number;
  /** Lines carrying at least one asserted component the label rejects, and the money on them. */
  linesWithAssertion: number;
  assertedCents: number;
  /** Alternates, add-ons and summaries read as priced work, and the money that would have been counted. */
  nonWorkLinesRead: number;
  nonWorkCentsRead: number;
  /** Labelled work lines whose work has no taxonomy id at all, and their money. */
  outsideLines: number;
  outsideCents: number;
  outsideNames: Record<string, number>;
  proposedComponents: number;
  foundComponents: number;
  documentAssertions: number;
  fullyRead: number;
  byTag: Record<string, { documents: number; linesRead: number; workLines: number; mapped: number; mappable: number; assertions: number }>;
  results: TransferDocumentResult[];
}

function positiveWork(quote: Quote): Set<ComponentId> {
  const out = new Set<ComponentId>();
  for (const item of quote.lineItems) {
    if (item.kind === "OPTIONAL") continue;
    for (const w of item.work) out.add(w.component);
  }
  return out;
}

function scoreDocument(doc: TransferDocument): TransferDocumentResult {
  const quote = parseQuoteText({
    id: "quote_t",
    caseId: "case_eval",
    text: doc.text,
    trade: doc.trade,
    source: "CONTRACTOR",
    defaultAction: "REPLACE",
    ...(doc.contractorName ? { contractorName: doc.contractorName } : {}),
    capturedAt: "2026-09-01T00:00:00.000Z",
  });
  const expect = doc.expect;
  const tolerated = new Set<ComponentId>(expect.tolerated ?? []);
  const proposes = new Set<ComponentId>(expect.proposes);
  const excludes = new Set<ComponentId>(expect.excludes ?? []);

  const lines: TransferLineResult[] = expect.lines.map((label) => {
    const item = quote.lineItems.find((li) => li.evidence?.line === label.line);
    const read = item !== undefined && item.amount === label.amountCents;
    const work = new Set<ComponentId>(item ? item.work.map((w) => w.component) : []);
    const wanted = label.components;
    const accepted = new Set<ComponentId>([...wanted, ...(label.tolerated ?? [])]);
    const missing = wanted.filter((c) => !work.has(c));
    // An option held out of the total asserts nothing about the proposal.
    const asserted = item?.kind === "OPTIONAL" ? [] : [...work].filter((c) => !accepted.has(c));
    return {
      line: label.line,
      excerpt: label.excerpt,
      kind: label.kind,
      amountCents: label.amountCents,
      read,
      readAsWork: read && item?.kind !== "OPTIONAL",
      mapped: read && missing.length === 0,
      missing,
      asserted,
      outside: label.outside ?? [],
    };
  });

  const found = positiveWork(quote);
  const lineTolerance = new Set<ComponentId>(expect.lines.flatMap((l) => [...l.components, ...(l.tolerated ?? [])]));
  const proposed = [...proposes];
  const missed = proposed.filter((c) => !found.has(c));
  const asserted = [...found].filter((c) => !proposes.has(c) && !tolerated.has(c) && !lineTolerance.has(c));
  const excludedAsserted = [...found].filter((c) => excludes.has(c));

  const totalRead = quote.total === expect.totalCents;
  const itemisationRead = (quote.itemisation?.level ?? "LUMP_SUM") === expect.itemisation;
  const result: TransferDocumentResult = {
    id: doc.id,
    title: doc.title,
    trade: doc.trade,
    tags: doc.tags,
    totalRead,
    totalCents: expect.totalCents,
    actualTotalCents: quote.total,
    itemisationRead,
    actualItemisation: quote.itemisation?.level ?? "LUMP_SUM",
    lines,
    proposed,
    found: [...found],
    missed,
    asserted,
    excludedAsserted,
    fullyRead:
      totalRead &&
      itemisationRead &&
      lines.every((l) => (l.kind === "work" ? l.read && l.mapped : true) && l.asserted.length === 0) &&
      missed.length === 0 &&
      asserted.length === 0 &&
      excludedAsserted.length === 0,
  };
  if (expect.depositCents !== undefined) result.depositRead = quote.deposit === expect.depositCents;
  return result;
}

export async function evaluateTransfer(file?: string): Promise<TransferReport> {
  const docs = await loadTransferDocuments(file);
  const results = docs.map(scoreDocument);
  const report: TransferReport = {
    documents: results.length,
    workLines: 0,
    workCents: 0,
    totalsRead: 0,
    itemisationRead: 0,
    linesRead: 0,
    linesReadCents: 0,
    mappable: 0,
    mapped: 0,
    mappedCents: 0,
    mappableCents: 0,
    linesWithAssertion: 0,
    assertedCents: 0,
    nonWorkLinesRead: 0,
    nonWorkCentsRead: 0,
    outsideLines: 0,
    outsideCents: 0,
    outsideNames: {},
    proposedComponents: 0,
    foundComponents: 0,
    documentAssertions: 0,
    fullyRead: 0,
    byTag: {},
    results,
  };
  const docsByLabel = new Map(docs.map((d) => [d.id, d]));

  for (const r of results) {
    const doc = docsByLabel.get(r.id)!;
    if (r.totalRead) report.totalsRead += 1;
    if (r.itemisationRead) report.itemisationRead += 1;
    if (r.fullyRead) report.fullyRead += 1;
    report.proposedComponents += r.proposed.length;
    report.foundComponents += r.proposed.length - r.missed.length;
    report.documentAssertions += r.asserted.length + r.excludedAsserted.length;

    const tagStats = doc.tags.map((t) => {
      const s = (report.byTag[t] ??= { documents: 0, linesRead: 0, workLines: 0, mapped: 0, mappable: 0, assertions: 0 });
      s.documents += 1;
      return s;
    });

    for (const line of r.lines) {
      const label = doc.expect.lines.find((l) => l.line === line.line)!;
      if (line.kind !== "work") {
        // Money that must not be read as work. Tax and credits are fine to
        // read; an alternate, add-on or summary read as a priced line is not.
        if (["alternate", "summary", "waived"].includes(line.kind) && line.readAsWork) {
          report.nonWorkLinesRead += 1;
          report.nonWorkCentsRead += line.amountCents;
        }
        if (line.asserted.length) {
          report.linesWithAssertion += 1;
          report.assertedCents += Math.max(0, line.amountCents);
          for (const s of tagStats) s.assertions += 1;
        }
        continue;
      }
      report.workLines += 1;
      report.workCents += line.amountCents;
      for (const s of tagStats) s.workLines += 1;
      if (line.read) {
        report.linesRead += 1;
        report.linesReadCents += line.amountCents;
        for (const s of tagStats) s.linesRead += 1;
      }
      const hasComponent = label.components.length > 0;
      if (!hasComponent && (label.outside ?? []).length > 0) {
        report.outsideLines += 1;
        report.outsideCents += line.amountCents;
      }
      for (const name of label.outside ?? []) report.outsideNames[name] = (report.outsideNames[name] ?? 0) + 1;
      if (line.read && hasComponent) {
        report.mappable += 1;
        report.mappableCents += line.amountCents;
        for (const s of tagStats) s.mappable += 1;
        if (line.mapped) {
          report.mapped += 1;
          report.mappedCents += line.amountCents;
          for (const s of tagStats) s.mapped += 1;
        }
      }
      if (line.asserted.length) {
        report.linesWithAssertion += 1;
        report.assertedCents += line.amountCents;
        for (const s of tagStats) s.assertions += 1;
      }
    }
  }
  return report;
}
