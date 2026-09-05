import type { CaseFacts } from "#domain";
import { contractorQuote, currentOffer, independentQuotes } from "#domain";
import type { CheckDimension, CheckStatus, VerificationCheck } from "#schema";
import { assertSafeLanguage, formatCents } from "#schema";
import { BASIS } from "./basis.js";

/**
 * The rules.
 *
 * Three properties hold for every one of them and are worth stating once.
 *
 * **`undefined` is not `false`.** "The customer has not told us whether a licence
 * was provided" and "no licence was provided" are different facts. The first is
 * VERIFY, an open question; the second is also VERIFY, because a missing licence
 * is still only a gap. Nothing becomes ATTENTION from an absence.
 *
 * **ATTENTION requires a positively recorded condition.** Someone has to have
 * said that the contractor knocked on the door, or that payment must be cash, or
 * that the decision is wanted today. This is the whole of the false-alarm
 * control, and it is measured on a corpus of ordinary repairs where the answer
 * is meant to be silence.
 *
 * **A rule describes the transaction, never the person.** Every statement passes
 * `assertSafeLanguage` before it leaves this file.
 */

export interface Rule {
  id: string;
  dimension: CheckDimension;
  /** Returns null when the rule does not apply to this case at all. */
  evaluate(facts: CaseFacts): Omit<VerificationCheck, "ruleId" | "dimension"> | null;
}

function check(
  status: CheckStatus,
  statement: string,
  basis: VerificationCheck["basis"],
  evidence: string[] = [],
  nextStep?: string,
): Omit<VerificationCheck, "ruleId" | "dimension"> {
  const out: Omit<VerificationCheck, "ruleId" | "dimension"> = {
    status,
    statement: assertSafeLanguage(statement),
    basis,
    evidence,
  };
  if (nextStep) out.nextStep = assertSafeLanguage(nextStep);
  return out;
}

/** Deposit share above which the payment schedule is worth a second look. */
export const DEPOSIT_ATTENTION_SHARE = 1 / 3;
/** Deposit share at which the schedule is a single payment in all but name. */
export const DEPOSIT_LARGE_SHARE = 0.5;

export const RULES: readonly Rule[] = [
  // ── identity ───────────────────────────────────────────────────────────────
  {
    id: "identity.contractor_named",
    dimension: "IDENTITY",
    evaluate(facts) {
      const offer = currentOffer(facts);
      if (!offer) return null;
      const name = offer.companyName ?? offer.contractorName;
      return name
        ? check("CLEAR", `The proposal is from ${name}.`, BASIS.FTC_HIRING_CONTRACTOR, [name])
        : check(
            "VERIFY",
            "No business name has been recorded for this proposal.",
            BASIS.FTC_HIRING_CONTRACTOR,
            [],
            "Ask for the business name and a phone number, and write them down.",
          );
    },
  },
  {
    id: "identity.licence_provided",
    dimension: "IDENTITY",
    evaluate(facts) {
      const offer = currentOffer(facts);
      if (!offer) return null;
      if (offer.context.licenceNumberProvided === true)
        return check("CLEAR", "A licence number has been provided.", BASIS.FTC_LICENCE_INSURANCE);
      return check(
        "VERIFY",
        "No licence number has been recorded.",
        BASIS.FTC_LICENCE_INSURANCE,
        [],
        "Ask for the licence number. It is a routine request and it is normally on the estimate.",
      );
    },
  },
  {
    id: "identity.licence_verified",
    dimension: "IDENTITY",
    evaluate(facts) {
      const offer = currentOffer(facts);
      if (!offer) return null;
      const lookup = facts.evidence.find((e) => e.kind === "LICENCE_LOOKUP");
      if (!lookup)
        return check(
          "VERIFY",
          "The licence has not been checked against a register.",
          BASIS.FTC_LICENCE_INSURANCE,
          [],
          "A state licence register can confirm the number is current and held by this business.",
        );
      switch (lookup.outcome) {
        case "MATCH":
          return check("CLEAR", `The licence was found on ${lookup.source} on ${lookup.recordedAt.slice(0, 10)}.`, BASIS.FTC_LICENCE_INSURANCE, [lookup.id]);
        case "NO_MATCH":
        case "NOT_FOUND":
          return check(
            "VERIFY",
            `The licence number was not found on ${lookup.source}. That can mean the number was written down wrong, or that the register covers a different trade or state.`,
            BASIS.FTC_LICENCE_INSURANCE,
            [lookup.id],
            "Read the number back to the contractor and check which state and trade the licence is held in.",
          );
        default:
          return check(
            "VERIFY",
            `The licence register was unavailable when it was checked on ${lookup.recordedAt.slice(0, 10)}.`,
            BASIS.FTC_LICENCE_INSURANCE,
            [lookup.id],
            "Worth trying again before work begins.",
          );
      }
    },
  },
  {
    id: "identity.insurance_evidence",
    dimension: "IDENTITY",
    evaluate(facts) {
      const offer = currentOffer(facts);
      if (!offer) return null;
      const certificate = facts.evidence.find((e) => e.kind === "INSURANCE_CERTIFICATE");
      if (certificate)
        return check("CLEAR", "A certificate of insurance is on file for this case.", BASIS.FTC_LICENCE_INSURANCE, [certificate.id]);
      if (offer.context.insuranceEvidenceProvided === true)
        return check("CLEAR", "Insurance evidence has been provided.", BASIS.FTC_LICENCE_INSURANCE);
      return check(
        "VERIFY",
        "No evidence of liability insurance has been recorded.",
        BASIS.FTC_LICENCE_INSURANCE,
        [],
        "Ask for a certificate of insurance. Insurers send these directly on request.",
      );
    },
  },

  // ── proposal ───────────────────────────────────────────────────────────────
  {
    id: "proposal.written_scope",
    dimension: "PROPOSAL",
    evaluate(facts) {
      const offer = currentOffer(facts);
      if (!offer) return null;
      const written = contractorQuote(facts)?.written === true || offer.context.writtenScopeProvided === true;
      return written
        ? check("CLEAR", "There is a written description of the work.", BASIS.FTC_WRITTEN_CONTRACT)
        : check(
            "VERIFY",
            "Nothing about this proposal is in writing yet.",
            BASIS.FTC_WRITTEN_CONTRACT,
            [],
            "Ask for the work, the materials, the price and the dates in writing before agreeing to anything.",
          );
    },
  },
  {
    id: "proposal.itemised",
    dimension: "PROPOSAL",
    evaluate(facts) {
      const quote = contractorQuote(facts);
      if (!quote) return null;
      const itemisation = quote.itemisation;
      if (!itemisation) return null;
      if (itemisation.level === "ITEMISED")
        return check(
          "CLEAR",
          `The quote attaches a price to each piece of work (${Math.round(itemisation.coverage * 100)} per cent of the total is on named line items).`,
          BASIS.CIRCA_ATTRIBUTION,
          [quote.id],
        );
      const share = Math.round(itemisation.coverage * 100);
      return check(
        "VERIFY",
        itemisation.level === "LUMP_SUM"
          ? `The quote is a single price of ${formatCents(quote.total)} for everything it describes. Nothing in it says how much of that belongs to which piece of work.`
          : `Only ${share} per cent of the ${formatCents(quote.total)} total is attached to named line items.`,
        BASIS.CIRCA_ATTRIBUTION,
        [quote.id],
        "An itemised version of the same quote is what makes it comparable with anyone else's.",
      );
    },
  },
  {
    id: "proposal.materials_described",
    dimension: "PROPOSAL",
    evaluate(facts) {
      const quote = contractorQuote(facts);
      if (!quote || quote.lineItems.length === 0) return null;
      const described = quote.lineItems.some((li) => li.kind === "MATERIAL" || li.kind === "COMBINED");
      return described
        ? check("CLEAR", "The quote names the materials it covers.", BASIS.FTC_WRITTEN_CONTRACT, [quote.id])
        : check(
            "VERIFY",
            "The quote does not separate materials from labour.",
            BASIS.FTC_WRITTEN_CONTRACT,
            [quote.id],
            "Ask which materials are included, by brand and grade where it matters.",
          );
    },
  },
  {
    id: "proposal.completion_date",
    dimension: "PROPOSAL",
    evaluate(facts) {
      const quote = contractorQuote(facts);
      if (!quote) return null;
      return quote.completionDate
        ? check("CLEAR", `The quote gives a completion date of ${quote.completionDate}.`, BASIS.FTC_WRITTEN_CONTRACT, [quote.id])
        : check(
            "VERIFY",
            "No completion date has been recorded.",
            BASIS.FTC_WRITTEN_CONTRACT,
            [quote.id],
            "Ask for a start date and a completion date in the written estimate.",
          );
    },
  },
  {
    id: "proposal.payment_schedule",
    dimension: "PROPOSAL",
    evaluate(facts) {
      const quote = contractorQuote(facts);
      if (!quote) return null;
      return quote.paymentSchedule.length > 0
        ? check(
            "CLEAR",
            `The quote sets out ${quote.paymentSchedule.length} payment stages.`,
            BASIS.FTC_PAYMENT_STAGES,
            [quote.id],
          )
        : check(
            "VERIFY",
            "The quote does not say when payments fall due.",
            BASIS.FTC_PAYMENT_STAGES,
            [quote.id],
            "Ask for payments to be tied to stages of work that have been finished.",
          );
    },
  },
  {
    id: "proposal.warranty",
    dimension: "PROPOSAL",
    evaluate(facts) {
      const quote = contractorQuote(facts);
      if (!quote) return null;
      return quote.warranty
        ? check("CLEAR", `The quote states a warranty: ${quote.warranty}.`, BASIS.FTC_WRITTEN_CONTRACT, [quote.id])
        : check("VERIFY", "No warranty is stated on the quote.", BASIS.FTC_WRITTEN_CONTRACT, [quote.id], "Ask what is covered on the workmanship and for how long.");
    },
  },

  // ── decision conditions ────────────────────────────────────────────────────
  {
    id: "conditions.unsolicited",
    dimension: "DECISION_CONDITIONS",
    evaluate(facts) {
      const offer = currentOffer(facts);
      if (!offer) return null;
      const how = offer.context.contractorFoundBy;
      if (how === undefined && offer.context.solicited === undefined) return null;
      const unsolicited = offer.context.solicited === false || how === "DOOR_KNOCK" || how === "PHONE_CALL";
      if (!unsolicited)
        return check("CLEAR", "You approached this contractor rather than the other way round.", BASIS.FTC_HOME_REPAIR_SCAMS);
      return check(
        "ATTENTION",
        how === "DOOR_KNOCK"
          ? "This work was offered at your door rather than sought out. Consumer guidance treats that as a reason to slow the decision down, not as a reason to refuse it."
          : "This work was offered unprompted. Consumer guidance treats that as a reason to slow the decision down, not as a reason to refuse it.",
        BASIS.FTC_HOME_REPAIR_SCAMS,
        [how ?? "unsolicited"],
        "Nothing here has to be decided at the door. A written estimate can be looked at later.",
      );
    },
  },
  {
    id: "conditions.immediate_decision",
    dimension: "DECISION_CONDITIONS",
    evaluate(facts) {
      const offer = currentOffer(facts);
      if (!offer) return null;
      const when = offer.context.decisionRequestedBy;
      if (when === undefined) return null;
      if (when === "IMMEDIATELY" || when === "TODAY")
        return check(
          "ATTENTION",
          "A decision has been asked for today. A price that is only good today is a term of the offer, not a fact about the roof.",
          BASIS.FTC_HOME_REPAIR_SCAMS,
          [when],
          "Ask whether the same price stands in writing for a week.",
        );
      return check("CLEAR", "No same-day decision has been asked for.", BASIS.FTC_HOME_REPAIR_SCAMS, [when]);
    },
  },
  {
    id: "conditions.urgency_unconfirmed",
    dimension: "DECISION_CONDITIONS",
    evaluate(facts) {
      const offer = currentOffer(facts);
      if (!offer?.context.urgencyClaim) return null;
      if (offer.context.independentUrgencyConfirmation === true)
        return check(
          "CLEAR",
          "The urgency has been confirmed by someone other than the contractor proposing the work.",
          BASIS.FTC_DISASTER_REPAIR,
        );
      return check(
        "VERIFY",
        `The only source for how urgent this is, is the person quoting for it. What was said was: "${offer.context.urgencyClaim}".`,
        BASIS.FTC_DISASTER_REPAIR,
        [offer.id],
        "An independent assessment can confirm the urgency and the work at the same time.",
      );
    },
  },
  {
    id: "conditions.damage_shown",
    dimension: "DECISION_CONDITIONS",
    evaluate(facts) {
      const offer = currentOffer(facts);
      if (!offer) return null;
      if (offer.context.damageShownToCustomer === undefined) return null;
      return offer.context.damageShownToCustomer
        ? check("CLEAR", "You have been shown the condition being quoted for.", BASIS.FTC_HIRING_CONTRACTOR)
        : check(
            "VERIFY",
            "You have not seen the condition this quote is for.",
            BASIS.FTC_HIRING_CONTRACTOR,
            [offer.id],
            "A photograph of the damage, taken where it is, is a reasonable thing to ask for.",
          );
    },
  },
  {
    id: "conditions.deposit_share",
    dimension: "DECISION_CONDITIONS",
    evaluate(facts) {
      const offer = currentOffer(facts);
      const quote = contractorQuote(facts);
      const deposit = offer?.depositRequested ?? quote?.deposit;
      const total = offer?.quotedPrice ?? quote?.total;
      if (deposit === undefined || total === undefined || total <= 0) return null;
      const share = deposit / total;
      const percent = Math.round(share * 100);
      if (share >= DEPOSIT_LARGE_SHARE)
        return check(
          "ATTENTION",
          `The deposit is ${formatCents(deposit)} of a ${formatCents(total)} job, which is ${percent} per cent before any work is done.`,
          BASIS.FTC_PAYMENT_STAGES,
          [`deposit=${deposit}`, `total=${total}`],
          "Consumer guidance is to tie payments to stages of work that have been completed.",
        );
      if (share > DEPOSIT_ATTENTION_SHARE)
        return check(
          "ATTENTION",
          `The deposit is ${percent} per cent of the total, taken before work starts.`,
          BASIS.FTC_PAYMENT_STAGES,
          [`deposit=${deposit}`, `total=${total}`],
          "Ask what the deposit is for. Ordered materials are a reason; a share of the labour is not.",
        );
      return check(
        "CLEAR",
        `The deposit is ${percent} per cent of the total.`,
        BASIS.FTC_PAYMENT_STAGES,
        [`deposit=${deposit}`, `total=${total}`],
      );
    },
  },
  {
    id: "conditions.payment_method",
    dimension: "DECISION_CONDITIONS",
    evaluate(facts) {
      const offer = currentOffer(facts);
      const quote = contractorQuote(facts);
      const methods = [...(offer?.context.paymentMethodsRequested ?? []), ...(quote?.paymentMethods ?? [])];
      if (methods.length === 0) return null;
      const irreversible = methods.filter((m) => m === "CASH" || m === "WIRE");
      const hasTraceable = methods.some((m) => m === "CARD" || m === "CHECK" || m === "ACH");
      if (irreversible.length > 0 && !hasTraceable)
        return check(
          "ATTENTION",
          `The only payment methods offered are ${irreversible.map((m) => m.toLowerCase()).join(" and ")}. Neither can be reversed once sent.`,
          BASIS.FTC_HOME_REPAIR_SCAMS,
          methods,
          "Ask whether a card or a cheque is acceptable. A business that takes one usually says so straight away.",
        );
      return check("CLEAR", "A traceable payment method is available.", BASIS.FTC_HOME_REPAIR_SCAMS, methods);
    },
  },

  // ── independent evidence ───────────────────────────────────────────────────
  {
    id: "evidence.second_opinion",
    dimension: "INDEPENDENT_EVIDENCE",
    evaluate(facts) {
      const independent = independentQuotes(facts);
      if (independent.length > 0)
        return check(
          "CLEAR",
          `There ${independent.length === 1 ? "is 1 independent assessment" : `are ${independent.length} independent assessments`} on this case.`,
          BASIS.FTC_HIRING_CONTRACTOR,
          independent.map((q) => q.id),
        );
      const requested = facts.secondOpinionRequests.length > 0;
      return check(
        "VERIFY",
        requested
          ? "An independent assessment has been requested and has not come back yet."
          : "Nothing independent has looked at this yet.",
        BASIS.AARP_HOME_IMPROVEMENT,
        [],
        "Comparing written estimates from more than one business is the single recommendation both the FTC and AARP lead with.",
      );
    },
  },
  {
    id: "evidence.photographs",
    dimension: "INDEPENDENT_EVIDENCE",
    evaluate(facts) {
      const photos = facts.evidence.filter((e) => e.kind === "PHOTO");
      if (photos.length > 0)
        return check(
          "CLEAR",
          `${photos.length} photograph${photos.length === 1 ? "" : "s"} of the condition ${photos.length === 1 ? "is" : "are"} on file.`,
          BASIS.CIRCA_EVIDENCE,
          photos.map((p) => p.id),
        );
      return check(
        "VERIFY",
        "There is no photograph of the condition on file.",
        BASIS.CIRCA_EVIDENCE,
        [],
        "A photograph taken before work starts is what makes a later disagreement about what was there answerable.",
      );
    },
  },
];

export const RULE_IDS = RULES.map((r) => r.id);
