/**
 * The document isolation boundary.
 *
 * A contractor's quote is a document written by the party the customer is
 * deciding about. Everything downstream — the normaliser, the rule engine, the
 * voice layer — treats a parsed quote as fact, so the moment the text becomes
 * something a model reads is the moment the other party gets a turn at the
 * controls.
 *
 * The defence here is structural rather than lexical. `scanForInjection` exists
 * to *measure* the attack surface and to label a document in the UI; it is not
 * what stops the attack. What stops the attack is that document text never
 * reaches an instruction position: it is parsed by code (`parseQuoteText`), and
 * where a model is involved it receives the text inside a delimited data
 * envelope produced by `renderForModel`, with the envelope's own rules stated
 * outside it.
 *
 * A filter that only blocked known phrasings would be a filter an attacker gets
 * to iterate against. The corpus in `fixtures/injection/` therefore measures two
 * different things: how many documents carry instructions (detection, which may
 * miss), and how many of those instructions reach the agent as instructions
 * (containment, which must be zero).
 */

export type InjectionCategory =
  | "INSTRUCTION_OVERRIDE"
  | "ROLE_REASSIGNMENT"
  | "TOOL_DIRECTION"
  | "OUTPUT_CONSTRAINT"
  | "EXFILTRATION"
  | "URGENCY_ESCALATION"
  | "HIDDEN_CHANNEL";

export interface InjectionFinding {
  category: InjectionCategory;
  /** The matched span, verbatim and truncated. Shown to the user, never acted on. */
  excerpt: string;
  line: number;
}

interface Detector {
  category: InjectionCategory;
  pattern: RegExp;
}

/**
 * Patterns seen in the wild and in the published prompt-injection literature,
 * grouped by what the instruction is trying to make the agent do rather than by
 * wording. Grouping by intent is what lets the corpus report a per-category
 * detection rate, which is the number that says where the detector is weak.
 */
const DETECTORS: readonly Detector[] = [
  { category: "INSTRUCTION_OVERRIDE", pattern: /\bignore (?:all |any )?(?:previous|prior|above|earlier)\s+(?:instructions?|prompts?|rules?|directions?)/i },
  { category: "INSTRUCTION_OVERRIDE", pattern: /\bdisregard (?:the |all |any )?(?:previous|prior|above|earlier|system)\b/i },
  { category: "INSTRUCTION_OVERRIDE", pattern: /\bnew instructions?\s*[:\-]/i },
  { category: "INSTRUCTION_OVERRIDE", pattern: /\boverrid(?:e|ing) (?:your |the )?(?:instructions?|system prompt|guidelines?)/i },
  { category: "ROLE_REASSIGNMENT", pattern: /\byou are (?:now |actually )?(?:a|an|the)\b[^.\n]{0,60}\b(?:assistant|agent|advisor|helper|system)\b/i },
  { category: "ROLE_REASSIGNMENT", pattern: /\b(?:system|assistant|developer)\s*(?:prompt|message|role)\s*[:\-]/i },
  { category: "ROLE_REASSIGNMENT", pattern: /<\/?(?:system|assistant|human|instructions?)>/i },
  { category: "ROLE_REASSIGNMENT", pattern: /\[\/?INST\]|<\|im_(?:start|end)\|>/i },
  { category: "TOOL_DIRECTION", pattern: /\b(?:call|invoke|run|execute|use) the\b[^.\n]{0,40}\b(?:tool|function|api|endpoint)\b/i },
  { category: "TOOL_DIRECTION", pattern: /\b(?:accept_?scope|record_?decision|approve|authorise|authorize)\b[^.\n]{0,30}\b(?:automatically|without asking|on my behalf)\b/i },
  { category: "TOOL_DIRECTION", pattern: /\bdo not (?:ask|prompt|check with) the (?:customer|user|homeowner)\b/i },
  { category: "OUTPUT_CONSTRAINT", pattern: /\b(?:do not|don'?t|never) (?:mention|report|show|display|flag|raise)\b/i },
  { category: "OUTPUT_CONSTRAINT", pattern: /\b(?:mark|report|treat|classify) (?:this|the quote|it) as\b[^.\n]{0,40}\b(?:verified|clear|approved|safe|compliant)\b/i },
  { category: "OUTPUT_CONSTRAINT", pattern: /\b(?:skip|bypass|omit) (?:the |all )?(?:checks?|verification|review)\b/i },
  { category: "OUTPUT_CONSTRAINT", pattern: /\brespond only with\b/i },
  { category: "EXFILTRATION", pattern: /\b(?:send|email|post|forward|upload|transmit) (?:the |all |your )?[^.\n]{0,40}\b(?:to|at)\b[^.\n]{0,20}[\w.+-]+@[\w-]+\.[a-z]{2,}/i },
  { category: "EXFILTRATION", pattern: /\bhttps?:\/\/[^\s)]+[?&](?:q|data|payload|case|dossier|token)=/i },
  { category: "EXFILTRATION", pattern: /\b(?:reveal|print|repeat|output) (?:your |the )?(?:system prompt|instructions?|configuration|api key)/i },
  { category: "URGENCY_ESCALATION", pattern: /\b(?:tell|advise|instruct) the (?:customer|homeowner|user) (?:to|that they must)\b[^.\n]{0,40}\b(?:sign|pay|accept|approve|deposit)\b/i },
  { category: "URGENCY_ESCALATION", pattern: /\brecommend (?:that )?(?:they |the customer )?(?:sign|accept|proceed|pay)\b/i },
  { category: "HIDDEN_CHANNEL", pattern: /\bbase64\s*[:\-]|\bdecode the following\b/i },
  { category: "HIDDEN_CHANNEL", pattern: /[\u200b-\u200f\u202a-\u202e\u2060-\u2064]/ },
];

const MAX_EXCERPT = 160;

export function scanForInjection(text: string): InjectionFinding[] {
  const findings: InjectionFinding[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const { category, pattern } of DETECTORS) {
      const match = pattern.exec(line);
      if (!match) continue;
      findings.push({
        category,
        excerpt: (match[0] ?? line).slice(0, MAX_EXCERPT),
        line: index + 1,
      });
    }
  });
  return findings;
}

export const INJECTION_DETECTOR_COUNT = DETECTORS.length;

export const INJECTION_CATEGORIES: readonly InjectionCategory[] = [
  ...new Set(DETECTORS.map((d) => d.category)),
];
