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
const FTC_HOME_IMPROVEMENT_URL = "https://consumer.ftc.gov/articles/how-avoid-home-improvement-scam";
const FTC_DISASTER_URL =
  "https://consumer.ftc.gov/articles/how-avoid-scams-after-weather-emergencies-and-natural-disasters";

export const BASIS = {
  FTC_HIRING_CONTRACTOR: {
    source: "FTC",
    reference:
      "FTC Consumer Advice, How To Avoid a Home Improvement Scam — get multiple estimates, and ask for an explanation if there is a big difference among them",
    url: FTC_HOME_IMPROVEMENT_URL,
  },
  FTC_WRITTEN_CONTRACT: {
    source: "FTC",
    reference:
      "FTC Consumer Advice, How To Avoid a Home Improvement Scam — a written estimate should include a description of the work, materials, completion date and price",
    url: FTC_HOME_IMPROVEMENT_URL,
  },
  FTC_PAYMENT_STAGES: {
    source: "FTC",
    reference:
      "FTC Consumer Advice, How To Avoid a Home Improvement Scam — do not pay the full amount up front, and never make the final payment until the work is done",
    url: FTC_HOME_IMPROVEMENT_URL,
  },
  FTC_HOME_REPAIR_SCAMS: {
    source: "FTC",
    reference:
      "FTC Consumer Advice, How To Avoid a Home Improvement Scam — signs of a scam include knocking on your door while in the area, pressure for an immediate decision, and asking to be paid up front or only in cash",
    url: FTC_HOME_IMPROVEMENT_URL,
  },
  FTC_LICENCE_INSURANCE: {
    source: "FTC",
    reference:
      "FTC Consumer Advice, How To Avoid a Home Improvement Scam — consider only contractors who are licensed and insured; confirm the licence and ask for proof of insurance",
    url: FTC_HOME_IMPROVEMENT_URL,
  },
  FTC_DISASTER_REPAIR: {
    source: "FTC",
    reference:
      "FTC Consumer Advice, How To Avoid Scams After Weather Emergencies and Natural Disasters — be skeptical of anyone promising immediate repairs, and of a discount offered only if you sign right away",
    url: FTC_DISASTER_URL,
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
