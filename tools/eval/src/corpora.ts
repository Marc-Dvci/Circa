import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ComponentId, OfferContext, Trade } from "#schema";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES = path.resolve(HERE, "../../../fixtures");

export interface Scenario {
  id: string;
  title: string;
  kind: "ORDINARY" | "CONDITIONS_PRESENT";
  trade: Trade;
  issueSummary: string;
  offer: {
    description: string;
    companyName?: string;
    contractorName?: string;
    /** Dollars, as the tool surface takes them. */
    quotedPrice?: number;
    depositRequested?: number;
    context?: Partial<OfferContext>;
  };
  answers?: Partial<OfferContext>;
  expectAttention: string[];
}

export interface QuoteSide {
  contractorName?: string;
  text?: string;
  spoken?: { description: string; total: number };
}

export interface QuotePair {
  id: string;
  title: string;
  trade: Trade;
  a: QuoteSide;
  b: QuoteSide;
  expect: {
    verdict: "COMPARABLE" | "SCOPE_DIFFERS" | "NOT_COMPARABLE";
    identifiable: boolean;
    reason?: string;
    headlineComponent?: string | null;
    sharedComponents?: string[];
    onlyAComponents?: string[];
    onlyBComponents?: string[];
    /** Components that must not appear in the alignment at all. */
    notAlignedComponents?: string[];
    /**
     * The decomposition itself, in cents, when the pair is attributable.
     *
     * Asserting the verdict and the component lists leaves the three numbers the
     * product actually reads aloud untested, and one of them was wrong for a
     * fortnight: a line asserting two components attached its amount to both, so
     * the rate difference double-counted it and the residual absorbed the
     * difference. Every figure a demo speaks belongs in a corpus.
     */
    scopeDifferenceCents?: number;
    rateDifferenceCents?: number;
    residualCents?: number;
  };
}

export interface InjectionDocument {
  id: string;
  title: string;
  hasInjection: boolean;
  categories: string[];
  text: string;
}

export interface TransferLine {
  line: number;
  excerpt: string;
  amountCents: number;
  /** `work` is scored; tax and credits are read but not work; alternate, summary and waived lines must not be read as priced work. */
  kind: "work" | "tax" | "credit" | "alternate" | "summary" | "waived";
  components: ComponentId[];
  tolerated?: ComponentId[];
  /** Work the line proposes that the taxonomy has no id for. */
  outside?: string[];
}

export interface TransferDocument {
  id: string;
  title: string;
  trade: Trade;
  tags: string[];
  contractorName?: string;
  text: string;
  expect: {
    totalCents: number;
    itemisation: "ITEMISED" | "PARTIAL" | "LUMP_SUM";
    depositCents?: number;
    lines: TransferLine[];
    proposes: ComponentId[];
    tolerated?: ComponentId[];
    outside?: string[];
    excludes?: ComponentId[];
  };
}

export async function loadScenarios(): Promise<Scenario[]> {
  const dir = path.join(FIXTURES, "scenarios");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  const out: Scenario[] = [];
  for (const file of files) {
    out.push(...(JSON.parse(await readFile(path.join(dir, file), "utf8")) as Scenario[]));
  }
  return out;
}

export async function loadQuotePairs(): Promise<QuotePair[]> {
  const raw = JSON.parse(await readFile(path.join(FIXTURES, "quotes", "pairs.json"), "utf8")) as { pairs: QuotePair[] };
  return raw.pairs;
}

export async function loadInjectionDocuments(): Promise<InjectionDocument[]> {
  const raw = JSON.parse(await readFile(path.join(FIXTURES, "injection", "documents.json"), "utf8")) as {
    documents: InjectionDocument[];
  };
  return raw.documents;
}

export async function loadTransferDocuments(): Promise<TransferDocument[]> {
  const raw = JSON.parse(await readFile(path.join(FIXTURES, "transfer", "estimates.json"), "utf8")) as {
    documents: TransferDocument[];
  };
  return raw.documents;
}
