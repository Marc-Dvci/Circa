import type { ComponentId, Offer, Trade, WorkUnit } from "#schema";
import { assertSafeLanguage, formatCents } from "#schema";
import { COMPONENTS, component, labelFor } from "#taxonomy";
import { normaliseLineItem } from "./lineitem.js";

/**
 * The neutral scope.
 *
 * A second opinion is only independent if the request does not carry the first
 * opinion's conclusion. "The roofer says the whole roof needs replacing, what do
 * you think" is not a second opinion; it is the first opinion with a second
 * signature on it. So the request CIRCA generates keeps the *observations* — the
 * area, the symptom, what the customer was shown — and withholds the diagnosis,
 * the proposed remedy, the price and the first contractor's name.
 *
 * `withheld` is returned rather than silently dropped, because the customer is
 * entitled to know what their own agent chose not to say on their behalf.
 */

export interface NeutralScope {
  caseId: string;
  trade: Trade;
  /** What is known to be true: the area, and what was observed. */
  symptom: string;
  /** Components an independent assessor should look at. */
  inspect: ComponentId[];
  inspectLabels: string[];
  /** What the assessment must come back with, whatever it finds. */
  requirements: string[];
  /** What CIRCA deliberately did not pass on, and why. */
  withheld: { what: string; why: string }[];
  /** The request as it would be sent to a provider. */
  text: string;
  generatedAt: string;
}

/**
 * Components worth inspecting alongside a named one.
 *
 * Not a diagnosis: an assessor who is asked to look at chimney flashing and
 * finds nothing should still have been asked to look at the deck under it,
 * because "there is no damage" is only useful if the right area was examined.
 * The relation is adjacency in the building, not causation.
 */
const ADJACENT: Partial<Record<ComponentId, readonly ComponentId[]>> = {
  "roof.chimney_flashing": ["roof.decking", "roof.shingles", "roof.chimney_crown"],
  "roof.shingles": ["roof.underlayment", "roof.decking"],
  "roof.decking": ["roof.rafters"],
  "roof.valley_flashing": ["roof.decking", "roof.shingles"],
  "roof.gutter": ["roof.fascia", "gen.grading"],
  "plumb.water_heater": ["plumb.expansion_tank", "plumb.pressure_regulator", "hvac.flue"],
  "plumb.toilet": ["plumb.toilet_flange", "plumb.wax_ring", "gen.flooring"],
  "plumb.sewer_line": ["plumb.drain_line", "gen.foundation"],
  "plumb.supply_line": ["plumb.main_shutoff", "gen.drywall"],
  "elec.panel": ["elec.breaker", "elec.grounding", "elec.meter_base"],
  "elec.outlet": ["elec.wiring", "elec.gfci"],
  "elec.wiring": ["elec.panel", "elec.grounding"],
  "hvac.furnace": ["hvac.heat_exchanger", "hvac.flue", "hvac.ductwork"],
  "hvac.ac_condenser": ["hvac.evaporator_coil", "hvac.refrigerant", "hvac.capacitor"],
  "hvac.evaporator_coil": ["hvac.condensate", "hvac.refrigerant"],
};

/**
 * Verbs that carry a conclusion. A scope request may say where to look; it may
 * not say what to do, because that is the question being asked.
 */
const REMEDY_ACTIONS = new Set(["REPLACE", "INSTALL", "REPAIR", "REMOVE", "SEAL"]);

function inspectSet(work: readonly WorkUnit[], trade: Trade): ComponentId[] {
  const out = new Set<ComponentId>();
  for (const unit of work) {
    const def = component(unit.component);
    if (!def) continue;
    // Seeds must belong to the trade under examination. The offer text is the
    // customer's account of a conversation, and it contains the narrative as
    // well as the work: "they knocked on the door and said the flashing has
    // failed" was putting a door on a roofer's inspection list. Adjacency below
    // may still reach outside the trade — a roof leak is assessed against the
    // ceiling under it — but a seed comes from something the offer proposed.
    if (trade !== "unknown" && def.trade !== trade) continue;
    // A quote for a whole-system replacement names no symptom. Fall back to the
    // parts of it a person can actually be shown.
    const named = def.includes && def.includes.length > 0 ? [...def.includes] : [unit.component];
    for (const id of named) {
      if (component(id)?.ancillary) continue;
      out.add(id);
      for (const neighbour of ADJACENT[id] ?? []) out.add(neighbour);
    }
  }
  if (out.size === 0) {
    // Nothing mapped: ask for a diagnostic on the trade rather than inventing a target.
    for (const def of COMPONENTS) {
      if (def.trade === trade && !def.ancillary && !def.includes) {
        out.add(def.id);
        if (out.size >= 4) break;
      }
    }
  }
  return [...out];
}

export function buildNeutralScope(
  offer: Offer,
  trade: Trade,
  now = new Date().toISOString(),
): NeutralScope {
  const normalised = normaliseLineItem(offer.description, trade, "UNKNOWN");
  const inspect = inspectSet(normalised.work, trade);
  const labels = inspect.map(labelFor);

  const shown = offer.context.damageShownToCustomer;
  const symptom = assertSafeLanguage(
    shown === true
      ? `The customer was shown a condition in the area listed below and would like it assessed independently.`
      : `A condition has been reported in the area listed below. The customer has not been shown it directly and would like it assessed independently.`,
  );

  const requirements = [
    "State what was observed, separately from what is recommended.",
    "Photograph any damaged component that is named.",
    "Give quantities and units for every item you propose.",
    "Price labour and materials separately.",
    "Name anything that could not be inspected, and say why.",
    "Do not carry out work beyond this assessment without a written, priced change.",
  ];

  const withheld: NeutralScope["withheld"] = [];
  const remedies = normalised.work.filter((w) => REMEDY_ACTIONS.has(w.action));
  if (remedies.length > 0) {
    withheld.push({
      what: remedies.map((w) => `${w.action.toLowerCase()} ${labelFor(w.component)}`).join(", "),
      why: "the first opinion's proposed remedy would anchor an independent assessment",
    });
  }
  if (offer.quotedPrice !== undefined) {
    withheld.push({
      what: `the quoted price (${formatCents(offer.quotedPrice)})`,
      why: "a stated price sets the range an independent quote is drawn towards",
    });
  }
  if (offer.contractorName || offer.companyName) {
    withheld.push({
      what: offer.companyName ?? offer.contractorName!,
      why: "naming the first contractor invites a comment on them rather than on the roof",
    });
  }
  if (offer.context.urgencyClaim) {
    withheld.push({
      what: `the urgency claim ("${offer.context.urgencyClaim}")`,
      why: "urgency asserted by one party is a claim to be assessed, not a premise to assess under",
    });
  }

  const text = [
    `Independent assessment requested — ${trade}.`,
    "",
    symptom,
    "",
    "Inspect:",
    ...labels.map((l) => `  • ${l}`),
    "",
    "The assessment must:",
    ...requirements.map((r) => `  • ${r}`),
  ].join("\n");

  return {
    caseId: offer.caseId,
    trade,
    symptom,
    inspect,
    inspectLabels: labels,
    requirements,
    withheld,
    text: assertSafeLanguage(text),
    generatedAt: now,
  };
}

/**
 * The anchoring guard.
 *
 * A scope that leaks the price or the remedy is not a neutral scope, and the
 * failure would be invisible — the request would still read fine. So it is
 * checked rather than trusted, and the check runs over every scenario in the
 * corpus, not only over the demo.
 */
export function findAnchoring(scope: NeutralScope, offer: Offer): string[] {
  const problems: string[] = [];
  const text = scope.text.toLowerCase();

  if (offer.quotedPrice !== undefined) {
    const dollars = Math.round(offer.quotedPrice / 100);
    const forms = [String(dollars), dollars.toLocaleString("en-US"), formatCents(offer.quotedPrice).toLowerCase()];
    for (const form of forms) {
      if (form.length >= 3 && text.includes(form)) problems.push(`quoted price leaked as "${form}"`);
    }
  }
  if (offer.contractorName && text.includes(offer.contractorName.toLowerCase()))
    problems.push(`contractor name leaked: ${offer.contractorName}`);
  if (offer.companyName && text.includes(offer.companyName.toLowerCase()))
    problems.push(`company name leaked: ${offer.companyName}`);

  const normalised = normaliseLineItem(scope.text, scope.trade, "UNKNOWN");
  for (const unit of normalised.work) {
    // Labour, materials and permits are bookkeeping, not a diagnosis. Asking an
    // assessor to price labour separately does not tell them what to conclude,
    // so flagging it would make the guard noisy in exactly the place a real leak
    // would then be missed.
    if (component(unit.component)?.ancillary) continue;
    if (REMEDY_ACTIONS.has(unit.action)) problems.push(`remedy leaked: ${unit.action} ${unit.component}`);
  }
  return [...new Set(problems)];
}
