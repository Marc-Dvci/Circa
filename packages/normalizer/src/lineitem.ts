import type { ComponentId, Trade, Unit, WorkAction, WorkUnit } from "#schema";
import { FALLBACK_LEXICON, LEXICON, component, findAction, normaliseText, type LexiconEntry } from "#taxonomy";

/**
 * Free text to work units.
 *
 * The rule this file exists to enforce: **a component may only be assigned when
 * one of its lexemes appears literally in the text.** Nothing here proposes work
 * from context, from the trade, or from what would be reasonable. A quote that
 * does not mention decking does not get a decking line, and no amount of model
 * assistance downstream can add one, because the model's output is passed back
 * through this function before it is believed.
 */

export interface NormalisedItem {
  /** Work the text asserts. */
  work: WorkUnit[];
  /** Components the text explicitly says are *not* included. Worth more than most line items. */
  excluded: ComponentId[];
  /** Phrases that matched more than one component and could not be resolved by trade. */
  ambiguous: { phrase: string; candidates: ComponentId[] }[];
  /** True when the text describes work but no lexeme matched. The reportable state. */
  unmapped: boolean;
}

const NEGATION_CUES: readonly RegExp[] = [
  /\bnot included\b/,
  /\bnot include\b/,
  /\bdoes not include\b/,
  /\bdo not include\b/,
  /\bdoesn t include\b/,
  /\bdon t include\b/,
  /\bexcluding\b/,
  /\bexcludes\b/,
  /\bexclusive of\b/,
  /\bexclusion\b/,
  /\bwithout\b/,
  /\bno (?:additional |further |visible |observed )?[a-z]/,
  /\bnone (?:observed|found|required|needed)\b/,
  /\bnot (?:observed|found|required|needed|necessary)\b/,
  /\bif (?:required|needed|necessary|found)\b/,
  /\bshould (?:it|any) be\b/,
];

/**
 * "if required" is a negation for scope purposes and this is deliberate.
 *
 * "Replace decking if required — $65/sheet" is not a commitment to replace
 * decking, and counting it as one lets a quote that has merely *mentioned* a
 * component appear to cover it. The customer-visible consequence is the right
 * one: the work is listed as conditional, not as included.
 */
export function isNegated(segment: string): boolean {
  return NEGATION_CUES.some((cue) => cue.test(segment));
}

/**
 * Split the **raw** text, not the normalised text.
 *
 * This was a bug, and an invisible one: normalisation strips punctuation, so
 * splitting afterwards left "Replace 8 shingles; no decking observed" as a
 * single segment, the negation cue in its second half applied to the whole
 * thing, and a quote that promised shingles was recorded as excluding them.
 * The polarity boundary is punctuation, so it has to be read before punctuation
 * is thrown away.
 */
const SEGMENT_BOUNDARY = /[;:,.]|(?:\s+(?:and|plus|also|but|however|note that|although|except)\s+)/i;

export function splitSegments(raw: string): string[] {
  return raw
    .split(SEGMENT_BOUNDARY)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const UNIT_LEXEMES: readonly (readonly [RegExp, Unit])[] = [
  [/\bsquare (?:feet|foot|ft)\b|\bsq ?ft\b|\bsf\b/, "sq_ft"],
  [/\blinear (?:feet|foot|ft)\b|\blin ?ft\b|\blf\b/, "linear_ft"],
  [/\bsquares?\b/, "square"],
  [/\bhours?\b|\bhrs?\b/, "hour"],
  [/\bdays?\b/, "day"],
  [/\beach\b|\bea\b|\bunits?\b|\bpieces?\b|\bpcs?\b/, "each"],
  [/\blot\b|\ballowance\b/, "lot"],
];

function unitNear(text: string): Unit | undefined {
  for (const [pattern, unit] of UNIT_LEXEMES) {
    if (pattern.test(text)) return unit;
  }
  return undefined;
}

/**
 * A quantity for a component, read from the window of text immediately before
 * the component phrase.
 *
 * Six words, because "replace approximately 60 square feet of roof decking" is
 * five words of lead-in and the next clause's number must not reach across.
 */
const QUANTITY_WINDOW_WORDS = 6;

function quantityFor(normalised: string, matchStart: number): { quantity?: number; unit?: Unit } {
  const before = normalised.slice(0, matchStart).trimEnd();
  const words = before.split(" ").filter(Boolean).slice(-QUANTITY_WINDOW_WORDS);
  const window = ` ${words.join(" ")} `;
  const numbers = [...window.matchAll(/\b(\d+(?:\.\d+)?)\b/g)];
  const last = numbers[numbers.length - 1];
  if (!last) return {};
  const value = Number(last[1]);
  if (!Number.isFinite(value) || value <= 0) return {};
  // A four-digit number is a year or a price, not a count of shingles.
  if (value >= 1000 && Number.isInteger(value)) return {};
  const after = window.slice(last.index! + last[0].length);
  return { quantity: value, unit: unitNear(after) ?? unitNear(window) };
}

interface Match {
  component: ComponentId;
  start: number;
  end: number;
  phrase: string;
}

/** Longest-first matching with span consumption, so "chimney flashing" suppresses "chimney". */
function matchComponents(
  normalised: string,
  trade: Trade,
  action: WorkAction,
): { matches: Match[]; ambiguous: NormalisedItem["ambiguous"] } {
  const taken: boolean[] = new Array(normalised.length).fill(false);
  const matches: Match[] = [];
  const ambiguous: NormalisedItem["ambiguous"] = [];
  const seenPhrase = new Set<string>();

  const scan = (lexicon: readonly LexiconEntry[]): void => {
  for (const entry of lexicon) {
    const needle = ` ${entry.phrase} `;
    let from = 0;
    for (;;) {
      const index = normalised.indexOf(needle, from);
      if (index === -1) break;
      from = index + 1;
      const start = index + 1;
      const end = start + entry.phrase.length;
      let overlaps = false;
      for (let i = start; i < end; i++) {
        if (taken[i]) {
          overlaps = true;
          break;
        }
      }
      if (overlaps) continue;

      // Every component that claims this exact phrase, in the lexicon being
      // scanned. Reading claimants out of LEXICON while scanning the fallback
      // list made every fallback phrase resolve against an empty claimant set,
      // so it was dropped as unresolvable and the whole fallback pass did
      // nothing — "replace the roof" mapped to no component at all.
      const claimants = lexicon.filter((e) => e.phrase === entry.phrase).map((e) => e.component);
      const resolved = resolveByTrade(claimants, trade);
      if (resolved === null) {
        if (!seenPhrase.has(entry.phrase)) {
          seenPhrase.add(entry.phrase);
          ambiguous.push({ phrase: entry.phrase, candidates: [...new Set(claimants)] });
        }
        // Consume the span anyway: an unresolved phrase must not fall through to
        // a shorter lexeme inside it and produce a confidently wrong component.
        for (let i = start; i < end; i++) taken[i] = true;
        continue;
      }
      for (let i = start; i < end; i++) taken[i] = true;
      matches.push({ component: resolved, start, end, phrase: entry.phrase });
    }
  }
  };

  scan(LEXICON);
  // The fallback pass runs only on a clause that named nothing. "Replace the
  // roof" is a whole roof; "replace roof decking" is not, and the difference is
  // whether the clause already told us which part. An entry that declares
  // `actions` fires only under those verbs, which is what keeps "seal roof
  // penetrations" from becoming a roof replacement.
  if (matches.length === 0) {
    scan(FALLBACK_LEXICON.filter((entry) => !entry.actions || entry.actions.includes(action)));
  }

  matches.sort((a, b) => a.start - b.start);
  return { matches, ambiguous };
}

/**
 * Resolve a phrase claimed by several components using the case's trade.
 *
 * Returns null when the trade does not settle it. Null is a first-class outcome:
 * an unresolved phrase is dropped and reported, never guessed. `unknown` trade
 * resolves only when exactly one claimant exists.
 */
export function resolveByTrade(candidates: readonly ComponentId[], trade: Trade): ComponentId | null {
  const unique = [...new Set(candidates)];
  if (unique.length === 1) return unique[0]!;
  if (trade === "unknown") return null;
  const inTrade = unique.filter((id) => component(id)?.trade === trade);
  if (inTrade.length === 1) return inTrade[0]!;
  if (inTrade.length === 0) {
    const general = unique.filter((id) => component(id)?.trade === "general");
    if (general.length === 1) return general[0]!;
  }
  return null;
}

/**
 * `defaultAction` is what a line item means when it names a component and no
 * verb. On a quote that is REPLACE; the scenario fixtures pass UNKNOWN so
 * nothing is inferred that was not written.
 */
export function normaliseLineItem(
  raw: string,
  trade: Trade,
  defaultAction: WorkAction = "UNKNOWN",
): NormalisedItem {
  // The verb for a clause with no verb of its own is the nearest one *before*
  // it, not the document's. "Replace chimney flashing and 8 shingles" needs the
  // fallback; a requirements list whose last paragraph happens to contain the
  // word "replacement" must not reach back and turn "materials" into a proposed
  // replacement six sentences earlier. That was a real leak, and it was found by
  // the anchoring guard rather than by reading this function.
  let lastAction: { action: WorkAction; phrase: string } | null = null;

  const positive = new Map<string, WorkUnit>();
  const negative = new Set<ComponentId>();
  const ambiguous: NormalisedItem["ambiguous"] = [];
  const seenAmbiguous = new Set<string>();
  let sawAnyComponent = false;

  for (const segment of splitSegments(raw)) {
    const normalised = normaliseText(segment);
    // The verb is resolved before the components, because a fallback form can
    // depend on it.
    const verb: { action: WorkAction; phrase: string } | null = findAction(normalised) ?? lastAction;
    if (verb) lastAction = verb;
    const { matches, ambiguous: segmentAmbiguous } = matchComponents(
      normalised,
      trade,
      verb?.action ?? defaultAction,
    );
    for (const entry of segmentAmbiguous) {
      if (seenAmbiguous.has(entry.phrase)) continue;
      seenAmbiguous.add(entry.phrase);
      ambiguous.push(entry);
    }
    if (matches.length > 0) sawAnyComponent = true;
    const negated = isNegated(normalised);

    for (const match of matches) {
      if (negated) {
        negative.add(match.component);
        continue;
      }
      const action: WorkAction = verb?.action ?? defaultAction;
      const key = `${match.component}#${action}`;
      if (positive.has(key)) continue;
      const { quantity, unit } = quantityFor(normalised, match.start);
      const def = component(match.component);
      const item: WorkUnit = { component: match.component, action };
      if (quantity !== undefined) item.quantity = quantity;
      const resolvedUnit = unit ?? def?.defaultUnit;
      if (resolvedUnit) item.unit = resolvedUnit;
      positive.set(key, item);
    }
  }

  const work = [...positive.values()];
  // A component asserted in one clause and denied in another is asserted. The
  // denial usually scopes something narrower ("replace flashing, no additional
  // flashing beyond the chimney"), and dropping the work would be the more
  // damaging of the two possible mistakes.
  const asserted = new Set(work.map((w) => w.component));
  const excluded = [...negative].filter((id) => !asserted.has(id));

  return {
    work,
    excluded,
    ambiguous,
    unmapped: raw.trim().length > 0 && !sawAnyComponent,
  };
}
