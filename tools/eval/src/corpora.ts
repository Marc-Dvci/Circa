import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { OfferContext, Trade } from "#schema";

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
  };
}

export interface InjectionDocument {
  id: string;
  title: string;
  hasInjection: boolean;
  categories: string[];
  text: string;
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
