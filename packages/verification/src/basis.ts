import type { Basis } from "#schema";

/**
 * The published guidance each rule implements.
 *
 * Every rule cites one of these. A rule with no external basis is labelled
 * `CIRCA_POLICY` and says so in the product, because the difference between "the
 * FTC recommends comparing written estimates" and "we think you should" is the
 * difference between a checklist a homeowner can act on and one they have to
 * take on faith.
 *
 * These references were read, not recalled. Where a rule needed a threshold the
 * guidance does not give — a deposit share, say — the threshold is CIRCA_POLICY
 * and the guidance is cited only for the shape of the advice.
 */
export const BASIS = {
  FTC_HIRING_CONTRACTOR: {
    source: "FTC",
    reference: "FTC Consumer Advice, Hiring a Contractor — get several written estimates and compare them",
    url: "https://consumer.ftc.gov/articles/hiring-contractor",
  },
  FTC_WRITTEN_CONTRACT: {
    source: "FTC",
    reference:
      "FTC Consumer Advice, Hiring a Contractor — the contract should state the work, materials, price, schedule and payment terms",
    url: "https://consumer.ftc.gov/articles/hiring-contractor",
  },
  FTC_PAYMENT_STAGES: {
    source: "FTC",
    reference:
      "FTC Consumer Advice, Hiring a Contractor — do not pay in full before the work is done; tie payments to completed stages",
    url: "https://consumer.ftc.gov/articles/hiring-contractor",
  },
  FTC_HOME_REPAIR_SCAMS: {
    source: "FTC",
    reference:
      "FTC Consumer Advice, Home Improvement Scams — unsolicited approaches, pressure to decide immediately, and demands for cash or wire payment",
    url: "https://consumer.ftc.gov/articles/home-improvement-scams",
  },
  FTC_LICENCE_INSURANCE: {
    source: "FTC",
    reference: "FTC Consumer Advice, Hiring a Contractor — check licensing and insurance before work begins",
    url: "https://consumer.ftc.gov/articles/hiring-contractor",
  },
  FTC_DISASTER_REPAIR: {
    source: "FTC",
    reference:
      "FTC Consumer Advice, Avoiding Scams After a Weather Emergency — verify before authorising urgent repair work",
    url: "https://consumer.ftc.gov/articles/avoiding-scams-after-weather-emergency",
  },
  AARP_HOME_IMPROVEMENT: {
    source: "AARP",
    reference:
      "AARP Fraud Resource Center, home improvement fraud — get multiple bids, be cautious of unsolicited and urgent offers",
    url: "https://www.aarp.org/money/scams-fraud/home-improvement/",
  },
  CIRCA_ATTRIBUTION: {
    source: "CIRCA_POLICY",
    reference:
      "CIRCA policy — a price is only comparable when the document attaches money to the work it describes",
  },
  CIRCA_BASELINE: {
    source: "CIRCA_POLICY",
    reference: "CIRCA policy — work outside the accepted scope is a proposed change until it is accepted in writing",
  },
  CIRCA_EVIDENCE: {
    source: "CIRCA_POLICY",
    reference: "CIRCA policy — a condition that changes the price should be documented before the price changes",
  },
} as const satisfies Record<string, Basis>;

export type BasisKey = keyof typeof BASIS;
