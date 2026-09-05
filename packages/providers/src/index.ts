import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Trade } from "#schema";
import { assertSafeLanguage, formatCents } from "#schema";

/**
 * Finding somebody to give the second opinion.
 *
 * The interesting decision in this file is what "best" means. It is not the
 * highest rating. A second opinion is worth something in proportion to how
 * little the assessor gains from the answer, so a business that only ever sells
 * assessments is ranked above a repair firm with better reviews, and the reason
 * is shown to the customer rather than folded into a score.
 *
 * That ordering is a product opinion and it is labelled as one. What is not an
 * opinion is that a firm which would also perform the repair has an interest in
 * finding one, and a homeowner comparing two quotes deserves to be told which of
 * the two people looking at their roof was paid the same either way.
 */

export interface Provider {
  id: string;
  name: string;
  trades: Trade[];
  postalCodes: string[];
  businessModel: "ASSESSMENT_ONLY" | "REPAIR_AND_ASSESSMENT";
  rating: number;
  reviewCount: number;
  responseHours: number;
  certifications: string[];
  assessmentFeeCents: number;
  typicalAssessmentHours: number;
  nextAvailableDays: number;
  notes: string;
}

export interface ProviderMatch {
  provider: Provider;
  /** Why this one is in the list and in this position. Shown verbatim. */
  reasons: string[];
  /** True when the provider has no financial interest in the outcome of the assessment. */
  independentOfOutcome: boolean;
}

export interface ProviderQuery {
  trade: Trade;
  postalCode?: string;
  limit?: number;
  /** Only businesses that do not also sell the repair. */
  independentOnly?: boolean;
  maxFeeCents?: number;
  withinDays?: number;
}

export interface ProviderRepository {
  find(query: ProviderQuery): Promise<ProviderMatch[]>;
  get(id: string): Promise<Provider | undefined>;
  describe(): string;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATASET = path.resolve(HERE, "../../../fixtures/providers/providers.json");

interface Dataset {
  _notice: string;
  regions: { postalCode: string; name: string }[];
  providers: Provider[];
}

/**
 * The demo marketplace.
 *
 * Thirty businesses that do not exist, labelled as such everywhere they surface.
 * `describe()` returns the label, the MCP tool result carries it, and the
 * simulator prints it above the list, because a synthetic directory presented
 * without that sentence is the one part of this project that could mislead
 * somebody about a real company.
 */
export class DemoProviderRepository implements ProviderRepository {
  private dataset: Dataset | undefined;

  constructor(private readonly datasetPath: string = DEFAULT_DATASET) {}

  private async load(): Promise<Dataset> {
    if (!this.dataset) {
      this.dataset = JSON.parse(await readFile(this.datasetPath, "utf8")) as Dataset;
    }
    return this.dataset;
  }

  describe(): string {
    return "Simulated professional marketplace (30 fictional businesses across 5 trades and 3 regions)";
  }

  async regions(): Promise<{ postalCode: string; name: string }[]> {
    return (await this.load()).regions;
  }

  async notice(): Promise<string> {
    return (await this.load())._notice;
  }

  async get(id: string): Promise<Provider | undefined> {
    return (await this.load()).providers.find((p) => p.id === id);
  }

  async find(query: ProviderQuery): Promise<ProviderMatch[]> {
    const { providers } = await this.load();
    const candidates = providers.filter((p) => {
      if (query.trade !== "unknown" && !p.trades.includes(query.trade)) return false;
      if (query.postalCode && !p.postalCodes.includes(query.postalCode)) return false;
      if (query.independentOnly && p.businessModel !== "ASSESSMENT_ONLY") return false;
      if (query.maxFeeCents !== undefined && p.assessmentFeeCents > query.maxFeeCents) return false;
      if (query.withinDays !== undefined && p.nextAvailableDays > query.withinDays) return false;
      return true;
    });
    return rank(candidates).slice(0, query.limit ?? 3);
  }
}

/**
 * Independence first, then how soon, then the record.
 *
 * A lexicographic order rather than a weighted sum, and deliberately: a weighted
 * sum would let a very high rating outweigh a direct financial interest in the
 * finding, and there is no exchange rate between those two things that anyone
 * could defend.
 */
export function rank(providers: readonly Provider[]): ProviderMatch[] {
  return [...providers]
    .sort((a, b) => {
      const independence = Number(b.businessModel === "ASSESSMENT_ONLY") - Number(a.businessModel === "ASSESSMENT_ONLY");
      if (independence !== 0) return independence;
      if (a.nextAvailableDays !== b.nextAvailableDays) return a.nextAvailableDays - b.nextAvailableDays;
      if (b.rating !== a.rating) return b.rating - a.rating;
      return b.reviewCount - a.reviewCount;
    })
    .map(describeMatch);
}

function describeMatch(provider: Provider): ProviderMatch {
  const independentOfOutcome = provider.businessModel === "ASSESSMENT_ONLY";
  const reasons: string[] = [];
  reasons.push(
    independentOfOutcome
      ? "Sells assessments and not repairs, so the same fee is paid whatever the assessment finds."
      : "Also performs repairs, so an assessment from this firm may be followed by its own quote for the work.",
  );
  reasons.push(
    provider.assessmentFeeCents === 0
      ? "No charge for the assessment."
      : `Assessment fee ${formatCents(provider.assessmentFeeCents)}.`,
  );
  reasons.push(
    provider.nextAvailableDays <= 1
      ? "Available tomorrow."
      : `Next availability in ${provider.nextAvailableDays} days.`,
  );
  if (provider.certifications.length > 0) {
    reasons.push(`States: ${provider.certifications.join(", ")}. CIRCA has not verified these.`);
  }
  return { provider, reasons: reasons.map(assertSafeLanguage), independentOfOutcome };
}

/** One line for a screen read from across a room. */
export function providerHeadline(match: ProviderMatch): string {
  const fee = match.provider.assessmentFeeCents === 0 ? "free" : formatCents(match.provider.assessmentFeeCents);
  return `${match.provider.name} — ${fee}, ${match.provider.nextAvailableDays <= 1 ? "tomorrow" : `in ${match.provider.nextAvailableDays} days`}${
    match.independentOfOutcome ? ", assessment only" : ""
  }`;
}
