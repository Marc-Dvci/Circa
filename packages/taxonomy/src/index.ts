import type { ComponentId, Trade, WorkAction } from "#schema";
import { COMPONENTS, type ComponentDef } from "./components.js";

export { COMPONENTS };
export type { ComponentDef };

const BY_ID = new Map<string, ComponentDef>(COMPONENTS.map((c) => [c.id, c]));

export function component(id: ComponentId): ComponentDef | undefined {
  return BY_ID.get(id);
}

export function labelFor(id: ComponentId): string {
  return BY_ID.get(id)?.label ?? id;
}

export function isKnownComponent(id: string): id is ComponentId {
  return BY_ID.has(id);
}

/**
 * Text normalisation, used identically on lexemes and on line items.
 *
 * Lower case, every non-alphanumeric run collapsed to a single space, and a
 * leading and trailing space so a lexeme can be matched as ` phrase ` without a
 * word-boundary regex per lexeme. Digits survive, because "3 tab" and "200 amp"
 * are lexemes.
 */
export function normaliseText(text: string): string {
  return ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
}

/**
 * Surface forms for a lexeme: the lexeme itself plus regular plurals.
 *
 * Only the final word is pluralised — "pipe boot" becomes "pipe boots", never
 * "pipes boot". Irregulars are not generated; a component that needs one lists
 * it explicitly, which is why `roof.gutter` does not carry "gutters" but
 * `plumb.p_trap` carries three spellings of itself.
 */
function surfaceForms(lexeme: string): string[] {
  const base = normaliseText(lexeme).trim();
  if (!base) return [];
  const forms = new Set<string>([base]);
  const words = base.split(" ");
  const last = words[words.length - 1]!;
  const head = words.slice(0, -1);
  const plural = /(s|x|z|ch|sh)$/.test(last) ? `${last}es` : /[^aeiou]y$/.test(last) ? `${last.slice(0, -1)}ies` : `${last}s`;
  forms.add([...head, plural].join(" "));
  return [...forms];
}

export interface LexiconEntry {
  phrase: string;
  component: ComponentId;
  /** Word count. Longest match wins, so "chimney flashing" beats "chimney". */
  words: number;
}

function buildLexicon(pick: (def: ComponentDef) => readonly string[]): LexiconEntry[] {
  const entries: LexiconEntry[] = [];
  const seen = new Set<string>();
  for (const def of COMPONENTS) {
    for (const lexeme of pick(def)) {
      for (const phrase of surfaceForms(lexeme)) {
        const key = `${phrase}|${def.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        entries.push({ phrase, component: def.id, words: phrase.split(" ").length });
      }
    }
  }
  entries.sort((a, b) => b.words - a.words || b.phrase.length - a.phrase.length || a.phrase.localeCompare(b.phrase));
  return entries;
}

/** Every surface form, longest first. Built once. */
export const LEXICON: readonly LexiconEntry[] = buildLexicon((def) => def.lexemes);

/**
 * The fallback lexicon, used only on a clause that matched nothing.
 *
 * Kept as a separate list rather than a flag on the entries, because the
 * matcher's contract is "longest match wins, spans are consumed" and a weak
 * entry mixed into that list would still consume a span. Two passes, the second
 * only when the first found nothing.
 */
export const FALLBACK_LEXICON: readonly LexiconEntry[] = buildLexicon((def) => def.fallbackLexemes ?? []);

/**
 * Phrases that more than one component claims.
 *
 * "coil" is an evaporator coil in an HVAC quote and nothing at all in a roofing
 * one; "panel" is an electrical panel or a siding panel. The normaliser resolves
 * these against the case's trade, and where the trade cannot resolve it the
 * mapping is dropped rather than guessed. Exported so the ambiguity is testable
 * and so `pnpm eval --lexicon` can report it rather than leaving it implicit.
 */
export const AMBIGUOUS_PHRASES: ReadonlyMap<string, readonly ComponentId[]> = (() => {
  const byPhrase = new Map<string, Set<ComponentId>>();
  for (const entry of LEXICON) {
    const set = byPhrase.get(entry.phrase) ?? new Set<ComponentId>();
    set.add(entry.component);
    byPhrase.set(entry.phrase, set);
  }
  const out = new Map<string, readonly ComponentId[]>();
  for (const [phrase, set] of byPhrase) {
    if (set.size > 1) out.set(phrase, [...set]);
  }
  return out;
})();

/** Transitive closure of `includes`. `roof.full_replacement` covers `gen.disposal`. */
export function covers(parent: ComponentId, child: ComponentId): boolean {
  if (parent === child) return true;
  const seen = new Set<ComponentId>();
  const stack: ComponentId[] = [...(BY_ID.get(parent)?.includes ?? [])];
  while (stack.length) {
    const next = stack.pop()!;
    if (next === child) return true;
    if (seen.has(next)) continue;
    seen.add(next);
    stack.push(...(BY_ID.get(next)?.includes ?? []));
  }
  return false;
}

export function expand(id: ComponentId): ComponentId[] {
  const out = new Set<ComponentId>([id]);
  const stack: ComponentId[] = [...(BY_ID.get(id)?.includes ?? [])];
  while (stack.length) {
    const next = stack.pop()!;
    if (out.has(next)) continue;
    out.add(next);
    stack.push(...(BY_ID.get(next)?.includes ?? []));
  }
  return [...out];
}

export function componentsForTrade(trade: Trade): ComponentDef[] {
  if (trade === "unknown") return [...COMPONENTS];
  return COMPONENTS.filter((c) => c.trade === trade || c.trade === "general");
}

/**
 * Action lexicon.
 *
 * Longest phrase first, for the same reason as the component lexicon: "does not
 * include" has to beat "include". Negation is handled by the normaliser, not
 * here; this map only says which verb was used.
 */
const ACTION_LEXEMES: readonly (readonly [string, WorkAction])[] = [
  ["tear off and replace", "REPLACE"],
  ["remove and replace", "REPLACE"],
  ["strip and replace", "REPLACE"],
  ["replacement of", "REPLACE"],
  ["replacement", "REPLACE"],
  ["replace", "REPLACE"],
  ["swap out", "REPLACE"],
  ["new", "REPLACE"],
  ["install", "INSTALL"],
  ["installation", "INSTALL"],
  ["fit", "INSTALL"],
  ["mount", "INSTALL"],
  ["add", "INSTALL"],
  ["repair", "REPAIR"],
  ["patch", "REPAIR"],
  ["fix", "REPAIR"],
  ["rebuild", "REPAIR"],
  ["resecure", "REPAIR"],
  ["re secure", "REPAIR"],
  ["reset", "REPAIR"],
  ["service", "REPAIR"],
  ["tune up", "REPAIR"],
  ["remove", "REMOVE"],
  ["tear off", "REMOVE"],
  ["strip", "REMOVE"],
  ["demolish", "REMOVE"],
  ["haul away", "DISPOSE"],
  ["dispose", "DISPOSE"],
  ["disposal", "DISPOSE"],
  ["dump", "DISPOSE"],
  ["inspect", "INSPECT"],
  ["inspection", "INSPECT"],
  ["assess", "INSPECT"],
  ["assessment", "INSPECT"],
  ["evaluate", "INSPECT"],
  ["evaluation", "INSPECT"],
  ["diagnose", "INSPECT"],
  ["diagnostic", "INSPECT"],
  ["survey", "INSPECT"],
  ["clean", "CLEAN"],
  ["cleaning", "CLEAN"],
  ["flush", "CLEAN"],
  ["seal", "SEAL"],
  ["sealing", "SEAL"],
  ["caulk", "SEAL"],
  ["waterproof", "SEAL"],
  ["test", "TEST"],
  ["pressure test", "TEST"],
  ["commission", "TEST"],
  ["protect", "PROTECT"],
  ["cover", "PROTECT"],
  ["tarp", "PROTECT"],
  ["permit", "PERMIT"],
  ["pull a permit", "PERMIT"],
];

const ACTION_LEXICON: readonly { phrase: string; action: WorkAction; words: number }[] = ACTION_LEXEMES.map(
  ([phrase, action]) => ({ phrase: normaliseText(phrase).trim(), action, words: phrase.split(" ").length }),
).sort((a, b) => b.words - a.words || b.phrase.length - a.phrase.length);

/** The first action verb present in already-normalised text, or null. */
export function findAction(normalised: string): { action: WorkAction; phrase: string } | null {
  let best: { action: WorkAction; phrase: string; index: number } | null = null;
  for (const { phrase, action } of ACTION_LEXICON) {
    const index = normalised.indexOf(` ${phrase} `);
    if (index === -1) continue;
    // Longest phrase wins; among equals, the earliest verb in the sentence.
    if (!best || phrase.length > best.phrase.length) best = { action, phrase, index };
  }
  return best ? { action: best.action, phrase: best.phrase } : null;
}

export const TAXONOMY_STATS = {
  components: COMPONENTS.length,
  lexicalForms: LEXICON.length,
  fallbackForms: FALLBACK_LEXICON.length,
  ambiguousPhrases: AMBIGUOUS_PHRASES.size,
  actionForms: ACTION_LEXICON.length,
} as const;
