import { findUnsafeLanguage, formatCents } from "#schema";
import type { ViewPayload } from "./present.js";

/**
 * Checking a generated sentence against the numbers it claims.
 *
 * A model rephrasing "of the $4,650 gap, $4,030 is work one includes and the
 * other does not" for a kitchen speaker is a genuine improvement: the
 * deterministic sentences are correct and they are stiff. What a model must not
 * do is produce a fluent sentence carrying a figure the comparison does not
 * support, and the reason that is the danger rather than a nuisance is that the
 * fluent version is the one the customer repeats to the contractor.
 *
 * So every generated sentence is checked back against the payload it came from,
 * by code, before it is spoken. Three things are checked and all three are hard
 * failures rather than warnings: forbidden language, money that is not in the
 * payload, and percentages that are not in the payload. On failure the
 * deterministic sentence is spoken instead. There is no third option where a
 * suspect sentence is spoken with a caveat.
 */

export interface VoiceCheck {
  ok: boolean;
  problems: string[];
  /** What to actually say: the model's sentence if it passed, the original if not. */
  speech: string;
}

const MONEY_IN_TEXT = /\$\s?([0-9][0-9,]*(?:\.[0-9]{2})?)/g;
const PERCENT_IN_TEXT = /\b([0-9]{1,3}(?:\.[0-9])?)\s*(?:per ?cent|%)/gi;

/** Every money figure the payload actually contains, in cents, at any depth. */
export function moneyIn(value: unknown, into = new Set<number>()): Set<number> {
  if (typeof value === "string") {
    for (const match of value.matchAll(MONEY_IN_TEXT)) {
      const cents = Math.round(Number((match[1] ?? "0").replace(/,/g, "")) * 100);
      if (Number.isFinite(cents)) into.add(cents);
    }
    return into;
  }
  if (Array.isArray(value)) {
    for (const item of value) moneyIn(item, into);
    return into;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) moneyIn(item, into);
    return into;
  }
  return into;
}

export function percentagesIn(value: unknown, into = new Set<number>()): Set<number> {
  if (typeof value === "string") {
    for (const match of value.matchAll(PERCENT_IN_TEXT)) {
      const percent = Number(match[1]);
      if (Number.isFinite(percent)) into.add(Math.round(percent));
    }
    return into;
  }
  if (typeof value === "number") {
    // A fraction in the payload is a percentage in the sentence. Both roundings
    // are allowed, because "34 per cent" and "35 per cent" are both defensible
    // readings of 0.345 and neither is an invention.
    if (value > 0 && value <= 1) {
      into.add(Math.round(value * 100));
      into.add(Math.floor(value * 100));
    }
    if (Number.isInteger(value) && value >= 0 && value <= 100) into.add(value);
    return into;
  }
  if (Array.isArray(value)) {
    for (const item of value) percentagesIn(item, into);
    return into;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) percentagesIn(item, into);
    return into;
  }
  return into;
}

/**
 * `tolerance` is one cent, not one dollar.
 *
 * Rounding "$4,030.00" to "$4,030" is a rendering choice. Rounding it to "about
 * four thousand" is a different claim, and the customer who repeats it to a
 * contractor is now negotiating against a number nobody wrote down.
 */
export function checkVoice(generated: string, payload: ViewPayload, fallback = payload.speech): VoiceCheck {
  const problems: string[] = [];

  const unsafe = findUnsafeLanguage(generated);
  if (unsafe) problems.push(`forbidden language (${unsafe.why}): "${unsafe.matched}"`);

  const allowedMoney = moneyIn(payload);
  for (const match of generated.matchAll(MONEY_IN_TEXT)) {
    const cents = Math.round(Number((match[1] ?? "0").replace(/,/g, "")) * 100);
    if (!allowedMoney.has(cents)) problems.push(`invented amount ${formatCents(cents)}`);
  }

  const allowedPercent = percentagesIn(payload);
  for (const match of generated.matchAll(PERCENT_IN_TEXT)) {
    const percent = Math.round(Number(match[1]));
    if (!allowedPercent.has(percent)) problems.push(`invented percentage ${percent}%`);
  }

  const ok = problems.length === 0;
  return { ok, problems, speech: ok ? generated : fallback };
}

/**
 * The instruction a model gets for voice rephrasing.
 *
 * It is short and it is negative, because everything positive it could say is
 * already true of the input: the payload arrives correct, and the only job is to
 * make it sound like a person without changing what it says. The check above is
 * what enforces this; the prompt is a courtesy to the model, not a control.
 */
export const VOICE_SYSTEM_PROMPT = `You rephrase one short result for a voice assistant speaking to a homeowner in their kitchen.

Rules:
- Say only what the result says. Every number you use must appear in the result.
- Never characterise the contractor. Talk about the transaction and the documents.
- Never say a price should be something. You have no price data.
- If the result declines to answer something, keep the refusal and keep the reason.
- Two or three sentences. No lists, no markdown, no preamble.`;
