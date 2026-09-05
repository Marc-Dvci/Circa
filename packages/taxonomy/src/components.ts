import type { ComponentId, Unit } from "#schema";

/**
 * The component vocabulary.
 *
 * Every entry is a thing a repair can be *about*. `lexemes` are the surface
 * forms that ground a mapping: a normaliser may only assign a component to a
 * line item when one of these appears literally in that line item's text. That
 * rule is what stops a model from inventing work that nobody wrote down, and it
 * is enforced in `packages/normalizer`, not requested in a prompt.
 *
 * `includes` is the subsumption relation, and it is the reason "replace the
 * roof" and "replace eight shingles" do not read as unrelated work. A quote for
 * a full replacement covers the shingles; a quote for the shingles does not
 * cover the replacement.
 */
export interface ComponentDef {
  id: ComponentId;
  label: string;
  trade: "roofing" | "plumbing" | "electrical" | "hvac" | "general";
  lexemes: readonly string[];
  /** Components this one contains. Transitive; the closure is computed in `index.ts`. */
  includes?: readonly ComponentId[];
  defaultUnit?: Unit;
  /**
   * A component whose presence in a quote is a *finding* rather than a line
   * item: structural work found behind a surface. Concealed work is the entire
   * subject of the change-order flow.
   */
  concealed?: boolean;
  /** Ancillary work: a fee, a disposal, a permit. Never the headline difference between two quotes. */
  ancillary?: boolean;
  /**
   * Surface forms that only apply when nothing more specific matched in the
   * same clause.
   *
   * They exist for one shape: the bare name of a whole system. "Replace the
   * roof" is a full replacement; "replace roof decking" is six sheets of
   * plywood, and the two differ by four thousand dollars. As an ordinary lexeme
   * "replace roof" is two words, so it won the longest-match contest against
   * "decking" and a decking line was recorded as a whole-roof line with the
   * decking's money attached to it. As a fallback it fires only when the clause
   * named no component at all, which is exactly when a bare system name is what
   * the writer meant.
   */
  fallbackLexemes?: readonly string[];
}

export const COMPONENTS: readonly ComponentDef[] = [
  // ── roofing ────────────────────────────────────────────────────────────────
  {
    id: "roof.full_replacement",
    label: "full roof replacement",
    trade: "roofing",
    lexemes: [
      "full roof replacement",
      "complete roof replacement",
      "new roof",
      "roof replacement",
      "reroof",
      "re-roof",
    ],
    // "roof" on its own means the whole roof only when the clause named no part
    // of one.
    fallbackLexemes: ["roof", "whole roof", "entire roof"],
    includes: [
      "roof.shingles",
      "roof.underlayment",
      "roof.drip_edge",
      "roof.ridge_vent",
      "roof.tearoff",
      "roof.pipe_boot",
      "roof.valley_flashing",
      "roof.starter",
      "gen.disposal",
    ],
    defaultUnit: "lot",
  },
  { id: "roof.shingles", label: "shingles", trade: "roofing", lexemes: ["shingle", "asphalt shingle", "architectural shingle", "three tab", "3 tab"], defaultUnit: "each" },
  { id: "roof.underlayment", label: "underlayment", trade: "roofing", lexemes: ["underlayment", "roofing felt", "tar paper", "ice and water shield", "ice and water barrier", "synthetic underlayment"], defaultUnit: "square" },
  { id: "roof.decking", label: "roof decking", trade: "roofing", lexemes: ["decking", "roof deck", "roof sheathing", "sheathing", "plywood", "osb"], defaultUnit: "sq_ft", concealed: true },
  { id: "roof.rafters", label: "rafters", trade: "roofing", lexemes: ["rafter", "roof truss", "truss"], defaultUnit: "each", concealed: true },
  // Bare "flashing" is what a quote usually says, and it does not name which
  // flashing. Rather than drop it or guess, it is its own component that
  // contains the specific ones, so a quote saying "replace flashing" and a quote
  // saying "replace chimney flashing" align through subsumption and the
  // comparison reports that one is broader than the other.
  { id: "roof.flashing", label: "flashing", trade: "roofing", lexemes: ["flashing"], includes: ["roof.chimney_flashing", "roof.valley_flashing", "roof.pipe_boot", "roof.drip_edge"], defaultUnit: "linear_ft" },
  { id: "roof.chimney_flashing", label: "chimney flashing", trade: "roofing", lexemes: ["chimney flashing", "step flashing", "counter flashing", "counterflashing", "flashing around the chimney", "chimney"], defaultUnit: "linear_ft" },
  { id: "roof.valley_flashing", label: "valley flashing", trade: "roofing", lexemes: ["valley flashing", "valley", "valleys"], defaultUnit: "linear_ft" },
  { id: "roof.pipe_boot", label: "pipe boots", trade: "roofing", lexemes: ["pipe boot", "vent boot", "plumbing boot", "pipe flashing", "vent flashing"], defaultUnit: "each" },
  { id: "roof.drip_edge", label: "drip edge", trade: "roofing", lexemes: ["drip edge"], defaultUnit: "linear_ft" },
  { id: "roof.starter", label: "starter course", trade: "roofing", lexemes: ["starter course", "starter strip", "starter shingle"], defaultUnit: "linear_ft" },
  { id: "roof.ridge_vent", label: "ridge vent", trade: "roofing", lexemes: ["ridge vent", "ridge cap", "ridge", "vent"], defaultUnit: "linear_ft" },
  { id: "roof.soffit_vent", label: "soffit venting", trade: "roofing", lexemes: ["soffit vent", "soffit"], defaultUnit: "each" },
  { id: "roof.fascia", label: "fascia", trade: "roofing", lexemes: ["fascia", "fascia board"], defaultUnit: "linear_ft" },
  { id: "roof.gutter", label: "gutters", trade: "roofing", lexemes: ["gutter", "eavestrough", "eaves trough"], defaultUnit: "linear_ft" },
  { id: "roof.downspout", label: "downspouts", trade: "roofing", lexemes: ["downspout", "down spout", "leader"], defaultUnit: "each" },
  { id: "roof.skylight", label: "skylight", trade: "roofing", lexemes: ["skylight", "sky light"], defaultUnit: "each" },
  { id: "roof.chimney_crown", label: "chimney crown", trade: "roofing", lexemes: ["chimney crown", "crown"], defaultUnit: "each" },
  { id: "roof.chimney_cap", label: "chimney cap", trade: "roofing", lexemes: ["chimney cap", "rain cap", "cap"], defaultUnit: "each" },
  { id: "roof.tarp", label: "emergency tarp", trade: "roofing", lexemes: ["tarp", "tarping", "emergency cover"], defaultUnit: "lot" },
  { id: "roof.tearoff", label: "tear-off", trade: "roofing", lexemes: ["tear off", "tear-off", "tearoff", "strip the roof", "remove existing shingle", "remove the existing roof"], defaultUnit: "square", ancillary: true },
  { id: "roof.attic_ventilation", label: "attic ventilation", trade: "roofing", lexemes: ["attic ventilation", "attic fan", "roof vent", "turbine vent"], defaultUnit: "each" },

  // ── plumbing ───────────────────────────────────────────────────────────────
  { id: "plumb.water_heater", label: "water heater", trade: "plumbing", lexemes: ["water heater", "hot water heater", "water tank", "hot water tank"], defaultUnit: "each" },
  { id: "plumb.water_heater_tankless", label: "tankless water heater", trade: "plumbing", lexemes: ["tankless", "on demand water heater", "combi boiler"], defaultUnit: "each" },
  { id: "plumb.expansion_tank", label: "expansion tank", trade: "plumbing", lexemes: ["expansion tank", "thermal expansion tank"], defaultUnit: "each" },
  { id: "plumb.main_shutoff", label: "main shutoff valve", trade: "plumbing", lexemes: ["main shutoff", "main shut off", "main shut-off", "main valve", "shutoff valve", "stop valve", "angle stop", "valve"], defaultUnit: "each" },
  { id: "plumb.supply_line", label: "supply line", trade: "plumbing", lexemes: ["supply line", "water line", "water supply", "riser"], defaultUnit: "linear_ft" },
  { id: "plumb.drain_line", label: "drain line", trade: "plumbing", lexemes: ["drain line", "waste line", "drain pipe", "drainage", "drain"], defaultUnit: "linear_ft" },
  { id: "plumb.sewer_line", label: "sewer line", trade: "plumbing", lexemes: ["sewer line", "sewer lateral", "main sewer", "sewer main"], defaultUnit: "linear_ft", concealed: true },
  { id: "plumb.p_trap", label: "P-trap", trade: "plumbing", lexemes: ["p trap", "p-trap", "ptrap", "trap arm"], defaultUnit: "each" },
  { id: "plumb.faucet", label: "faucet", trade: "plumbing", lexemes: ["faucet", "tap", "mixer tap"], defaultUnit: "each" },
  { id: "plumb.toilet", label: "toilet", trade: "plumbing", lexemes: ["toilet", "commode", "water closet"], defaultUnit: "each" },
  { id: "plumb.toilet_flange", label: "toilet flange", trade: "plumbing", lexemes: ["toilet flange", "closet flange", "flange"], defaultUnit: "each", concealed: true },
  { id: "plumb.wax_ring", label: "wax ring", trade: "plumbing", lexemes: ["wax ring", "wax seal"], defaultUnit: "each" },
  { id: "plumb.sink", label: "sink", trade: "plumbing", lexemes: ["sink", "basin", "lavatory"], defaultUnit: "each" },
  { id: "plumb.garbage_disposal", label: "garbage disposal", trade: "plumbing", lexemes: ["garbage disposal", "disposer", "waste disposal unit"], defaultUnit: "each" },
  { id: "plumb.shower_valve", label: "shower valve", trade: "plumbing", lexemes: ["shower valve", "mixing valve", "shower cartridge", "cartridge", "valve"], defaultUnit: "each" },
  { id: "plumb.pipe_copper", label: "copper piping", trade: "plumbing", lexemes: ["copper pipe", "copper piping", "repipe", "re-pipe", "repiping"], includes: ["plumb.supply_line"], defaultUnit: "linear_ft" },
  { id: "plumb.pipe_pex", label: "PEX piping", trade: "plumbing", lexemes: ["pex"], includes: ["plumb.supply_line"], defaultUnit: "linear_ft" },
  { id: "plumb.sump_pump", label: "sump pump", trade: "plumbing", lexemes: ["sump pump", "sump"], defaultUnit: "each" },
  { id: "plumb.pressure_regulator", label: "pressure regulator", trade: "plumbing", lexemes: ["pressure regulator", "pressure reducing valve", "prv"], defaultUnit: "each" },
  { id: "plumb.leak_detection", label: "leak detection", trade: "plumbing", lexemes: ["leak detection", "locate the leak", "camera inspection", "scope the line", "line camera"], defaultUnit: "lot" },
  { id: "plumb.hose_bib", label: "hose bib", trade: "plumbing", lexemes: ["hose bib", "spigot", "outdoor faucet", "sillcock"], defaultUnit: "each" },
  { id: "plumb.backflow", label: "backflow preventer", trade: "plumbing", lexemes: ["backflow preventer", "backflow", "check valve"], defaultUnit: "each" },

  // ── electrical ─────────────────────────────────────────────────────────────
  { id: "elec.panel", label: "electrical panel", trade: "electrical", lexemes: ["electrical panel", "breaker panel", "load center", "load centre", "service panel", "panel"], defaultUnit: "each" },
  { id: "elec.service_upgrade", label: "service upgrade", trade: "electrical", lexemes: ["service upgrade", "amp service", "service entrance", "upgrade the service"], includes: ["elec.panel", "elec.meter_base", "elec.grounding", "elec.breaker"], defaultUnit: "lot" },
  { id: "elec.meter_base", label: "meter base", trade: "electrical", lexemes: ["meter base", "meter can", "meter socket"], defaultUnit: "each" },
  { id: "elec.breaker", label: "circuit breaker", trade: "electrical", lexemes: ["circuit breaker", "breaker"], defaultUnit: "each" },
  { id: "elec.gfci", label: "GFCI protection", trade: "electrical", lexemes: ["gfci", "ground fault", "gfi"], defaultUnit: "each" },
  { id: "elec.afci", label: "AFCI protection", trade: "electrical", lexemes: ["afci", "arc fault"], defaultUnit: "each" },
  { id: "elec.outlet", label: "outlets", trade: "electrical", lexemes: ["outlet", "receptacle", "wall socket", "power point"], defaultUnit: "each" },
  { id: "elec.switch", label: "switches", trade: "electrical", lexemes: ["light switch", "dimmer", "three way switch", "switch"], defaultUnit: "each" },
  { id: "elec.wiring", label: "wiring", trade: "electrical", lexemes: ["wiring", "rewire", "rewiring", "romex", "new circuit", "circuit run", "run a circuit"], defaultUnit: "linear_ft", concealed: true },
  { id: "elec.knob_and_tube", label: "knob-and-tube wiring", trade: "electrical", lexemes: ["knob and tube", "knob-and-tube"], defaultUnit: "linear_ft", concealed: true },
  { id: "elec.aluminum_wiring", label: "aluminium branch wiring", trade: "electrical", lexemes: ["aluminum wiring", "aluminium wiring", "alumiconn", "copalum"], defaultUnit: "each", concealed: true },
  { id: "elec.grounding", label: "grounding and bonding", trade: "electrical", lexemes: ["grounding", "ground rod", "bonding", "ground wire"], defaultUnit: "lot" },
  { id: "elec.fixture", label: "light fixtures", trade: "electrical", lexemes: ["light fixture", "recessed light", "can light", "fixture", "sconce"], defaultUnit: "each" },
  { id: "elec.ceiling_fan", label: "ceiling fan", trade: "electrical", lexemes: ["ceiling fan"], defaultUnit: "each" },
  { id: "elec.smoke_detector", label: "smoke detectors", trade: "electrical", lexemes: ["smoke detector", "smoke alarm", "co detector", "carbon monoxide detector"], defaultUnit: "each" },
  { id: "elec.ev_charger", label: "EV charger", trade: "electrical", lexemes: ["ev charger", "car charger", "level 2 charger", "evse"], defaultUnit: "each" },
  { id: "elec.generator_interlock", label: "generator interlock", trade: "electrical", lexemes: ["generator interlock", "transfer switch", "interlock kit"], defaultUnit: "each" },

  // ── hvac ───────────────────────────────────────────────────────────────────
  { id: "hvac.system_replacement", label: "full system replacement", trade: "hvac", lexemes: ["new system", "system replacement", "replace the system", "full system", "furnace and ac", "complete hvac"], includes: ["hvac.furnace", "hvac.ac_condenser", "hvac.evaporator_coil", "hvac.air_handler"], defaultUnit: "lot" },
  { id: "hvac.furnace", label: "furnace", trade: "hvac", lexemes: ["furnace", "boiler"], defaultUnit: "each" },
  { id: "hvac.heat_exchanger", label: "heat exchanger", trade: "hvac", lexemes: ["heat exchanger", "cracked exchanger"], defaultUnit: "each", concealed: true },
  { id: "hvac.ac_condenser", label: "condenser", trade: "hvac", lexemes: ["condenser", "condensing unit", "outdoor unit", "compressor"], defaultUnit: "each" },
  { id: "hvac.evaporator_coil", label: "evaporator coil", trade: "hvac", lexemes: ["evaporator coil", "evaporator", "a coil", "a-coil", "indoor coil", "coil"], defaultUnit: "each" },
  { id: "hvac.air_handler", label: "air handler", trade: "hvac", lexemes: ["air handler", "air handling unit", "ahu"], defaultUnit: "each" },
  { id: "hvac.blower_motor", label: "blower motor", trade: "hvac", lexemes: ["blower motor", "fan motor", "blower"], defaultUnit: "each" },
  { id: "hvac.capacitor", label: "capacitor", trade: "hvac", lexemes: ["capacitor", "run capacitor", "start capacitor", "dual cap", "cap"], defaultUnit: "each" },
  { id: "hvac.contactor", label: "contactor", trade: "hvac", lexemes: ["contactor"], defaultUnit: "each" },
  { id: "hvac.refrigerant", label: "refrigerant", trade: "hvac", lexemes: ["refrigerant", "freon", "r 410a", "r410a", "r 22", "recharge", "top off the charge"], defaultUnit: "lot" },
  { id: "hvac.thermostat", label: "thermostat", trade: "hvac", lexemes: ["thermostat", "smart thermostat"], defaultUnit: "each" },
  { id: "hvac.ductwork", label: "ductwork", trade: "hvac", lexemes: ["ductwork", "duct work", "duct", "supply plenum", "return plenum"], defaultUnit: "linear_ft", concealed: true },
  { id: "hvac.duct_sealing", label: "duct sealing", trade: "hvac", lexemes: ["duct sealing", "aeroseal", "mastic"], defaultUnit: "lot" },
  { id: "hvac.duct_cleaning", label: "duct cleaning", trade: "hvac", lexemes: ["duct cleaning", "air duct cleaning"], defaultUnit: "lot" },
  { id: "hvac.filter", label: "air filter", trade: "hvac", lexemes: ["air filter", "media filter", "filter"], defaultUnit: "each" },
  { id: "hvac.condensate", label: "condensate drain", trade: "hvac", lexemes: ["condensate", "drain pan", "condensate pump", "secondary pan", "drain"], defaultUnit: "each" },
  { id: "hvac.heat_pump", label: "heat pump", trade: "hvac", lexemes: ["heat pump", "mini split", "mini-split", "ductless"], defaultUnit: "each" },
  { id: "hvac.flue", label: "flue and venting", trade: "hvac", lexemes: ["flue", "vent pipe", "b vent", "chimney liner", "vent"], defaultUnit: "linear_ft" },

  // ── general and cross-trade ────────────────────────────────────────────────
  { id: "gen.drywall", label: "drywall", trade: "general", lexemes: ["drywall", "sheetrock", "plasterboard", "plaster"], defaultUnit: "sq_ft" },
  { id: "gen.paint", label: "paint", trade: "general", lexemes: ["paint", "painting", "primer", "repaint"], defaultUnit: "sq_ft" },
  { id: "gen.insulation", label: "insulation", trade: "general", lexemes: ["insulation", "batt", "blown in", "blown-in", "spray foam"], defaultUnit: "sq_ft" },
  { id: "gen.mold_remediation", label: "mould remediation", trade: "general", lexemes: ["mold", "mould", "remediation", "microbial"], defaultUnit: "sq_ft", concealed: true },
  { id: "gen.water_damage", label: "water damage mitigation", trade: "general", lexemes: ["water damage", "water mitigation", "dry out", "dryout", "dehumidifier", "drying equipment"], defaultUnit: "lot", concealed: true },
  { id: "gen.flooring", label: "flooring", trade: "general", lexemes: ["flooring", "subfloor", "sub floor", "underlay", "laminate", "hardwood floor"], defaultUnit: "sq_ft" },
  { id: "gen.window", label: "window", trade: "general", lexemes: ["window", "sash", "glazing"], defaultUnit: "each" },
  { id: "gen.door", label: "door", trade: "general", lexemes: ["door", "doorway", "threshold"], defaultUnit: "each" },
  { id: "gen.siding", label: "siding", trade: "general", lexemes: ["siding", "cladding", "clapboard", "siding panel", "panel"], defaultUnit: "sq_ft" },
  { id: "gen.trim", label: "trim", trade: "general", lexemes: ["trim", "molding", "moulding", "baseboard", "casing"], defaultUnit: "linear_ft" },
  { id: "gen.framing", label: "framing", trade: "general", lexemes: ["framing", "stud", "joist", "header", "sister the joist"], defaultUnit: "linear_ft", concealed: true },
  { id: "gen.foundation", label: "foundation", trade: "general", lexemes: ["foundation", "footing", "slab", "crawlspace", "crawl space"], defaultUnit: "linear_ft", concealed: true },
  { id: "gen.grading", label: "grading and drainage", trade: "general", lexemes: ["grading", "regrade", "french drain", "swale"], defaultUnit: "linear_ft" },
  { id: "gen.permit", label: "permit", trade: "general", lexemes: ["permit", "permit fee", "building permit", "pull a permit"], defaultUnit: "lot", ancillary: true },
  { id: "gen.disposal", label: "debris disposal", trade: "general", lexemes: ["dumpster", "debris removal", "haul away", "disposal fee", "disposal", "landfill"], defaultUnit: "lot", ancillary: true },
  { id: "gen.trip_charge", label: "service call", trade: "general", lexemes: ["trip charge", "service call", "call out fee", "call-out fee", "diagnostic fee", "dispatch fee"], defaultUnit: "each", ancillary: true },
  { id: "gen.labor", label: "labour", trade: "general", lexemes: ["labor", "labour", "man hour", "man-hour", "hourly rate", "crew time"], defaultUnit: "hour", ancillary: true },
  { id: "gen.materials", label: "materials", trade: "general", lexemes: ["materials", "material cost", "supplies"], defaultUnit: "lot", ancillary: true },
  { id: "gen.cleanup", label: "clean-up", trade: "general", lexemes: ["cleanup", "clean up", "clean-up", "site clean", "magnet sweep"], defaultUnit: "lot", ancillary: true },
  { id: "gen.protection", label: "site protection", trade: "general", lexemes: ["drop cloth", "site protection", "masking", "protect the landscaping", "plywood protection"], defaultUnit: "lot", ancillary: true },
  { id: "gen.inspection", label: "inspection", trade: "general", lexemes: ["inspection", "assessment", "evaluation", "evaluate", "diagnostic", "site visit", "second opinion"], defaultUnit: "lot" },
  { id: "gen.warranty", label: "warranty", trade: "general", lexemes: ["warranty", "guarantee", "workmanship warranty"], defaultUnit: "lot", ancillary: true },
  { id: "gen.emergency_callout", label: "emergency call-out", trade: "general", lexemes: ["emergency", "after hours", "after-hours", "overtime rate", "weekend rate"], defaultUnit: "lot", ancillary: true },
  { id: "gen.engineering", label: "engineering report", trade: "general", lexemes: ["engineer report", "structural engineer", "engineering letter", "stamped drawing"], defaultUnit: "lot" },
];
