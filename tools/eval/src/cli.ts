import { writeFile } from "node:fs/promises";
import { AMBIGUOUS_PHRASES, TAXONOMY_STATS } from "#taxonomy";
import { RULE_IDS } from "#verification";
import { INJECTION_CATEGORIES, INJECTION_DETECTOR_COUNT } from "#documents";
import { evaluateInjection, evaluateQuotePairs, evaluateScenarios } from "./run.js";
import { evaluateTransfer } from "./transfer.js";

/**
 * `pnpm eval`.
 *
 * Prints the three numbers a judge should be handed first, in the order they
 * should be read: the false-alarm rate on ordinary repairs, the refusal rate on
 * quote pairs that cannot be attributed, and the containment failures on
 * documents that talk to the agent. Two of those three are numbers a product is
 * usually shy about, which is why they lead.
 *
 * Exits non-zero on any regression, so `pnpm verify` is a gate rather than a
 * report.
 */

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;
// One space of gutter, always: "controls that tripped the detector" is 34
// characters, so padEnd(34) printed the value hard against it as
// "...the detector0".
const bar = (label: string, value: string): string => `  ${label.padEnd(36)}${value}`;

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const only = (name: string): boolean => args.size === 0 || args.has(`--${name}`) || args.has("--all");
  const lines: string[] = [];
  let failed = false;
  const json: Record<string, unknown> = {};

  if (only("scenarios")) {
    const report = await evaluateScenarios();
    json["scenarios"] = { ...report, results: report.results.map((r) => ({ ...r })) };
    lines.push("");
    lines.push(`SCENARIOS  ${report.total} repairs, ${report.ordinary} of them ordinary jobs where silence is correct`);
    lines.push(bar("false alarms on ordinary jobs", `${pct(report.falseAlarmRate)}  (${report.results.filter((r) => r.kind === "ORDINARY" && r.actual.length > 0).length} of ${report.ordinary})`));
    lines.push(bar("ATTENTION precision", pct(report.attentionPrecision)));
    lines.push(bar("ATTENTION recall", pct(report.attentionRecall)));
    lines.push(bar("scenarios fully correct", `${report.passed} of ${report.total}`));
    lines.push(bar("forbidden language emitted", String(report.languageFailures)));
    lines.push(bar("assessment requests that leaked", String(report.scopeLeakFailures)));
    lines.push(
      bar(
        "rules citing published guidance",
        `${report.rulesCitingGuidance} of ${report.rulesCitingGuidance + report.rulesCitingPolicy}  (the rest say CIRCA_POLICY)`,
      ),
    );
    if (args.has("--scenarios") || args.has("--verbose")) {
      for (const result of report.results.filter((r) => !r.pass)) {
        lines.push(`    ${result.id}  ${result.title}`);
        if (result.spurious.length) lines.push(`      fired but not expected: ${result.spurious.join(", ")}`);
        if (result.missed.length) lines.push(`      expected but silent:    ${result.missed.join(", ")}`);
        for (const problem of result.languageProblems) lines.push(`      language: ${problem}`);
        for (const leak of result.scopeLeaks) lines.push(`      scope leak: ${leak}`);
      }
    }
    if (report.passed !== report.total) failed = true;
  }

  if (only("quotes")) {
    const report = await evaluateQuotePairs();
    json["quotes"] = report;
    lines.push("");
    lines.push(`QUOTE PAIRS  ${report.total} labelled pairs, ${report.refusalsExpected} of which cannot be attributed`);
    lines.push(bar("correct refusals", `${pct(report.refusalRecall)}  (recall)`));
    lines.push(bar("refusals that were right", `${pct(report.refusalPrecision)}  (precision)`));
    lines.push(bar("verdict accuracy", pct(report.verdictAccuracy)));
    lines.push(bar("component alignment accuracy", pct(report.alignmentAccuracy)));
    lines.push(bar("pairs fully correct", `${report.passed} of ${report.total}`));
    if (args.has("--quotes") || args.has("--verbose")) {
      for (const result of report.results.filter((r) => !r.pass)) {
        lines.push(`    ${result.id}  ${result.title}`);
        if (result.verdict !== result.expectedVerdict) lines.push(`      verdict: expected ${result.expectedVerdict}, got ${result.verdict}`);
        if (result.identifiable !== result.expectedIdentifiable)
          lines.push(`      attribution: expected identifiable=${result.expectedIdentifiable}, got ${result.identifiable}`);
        if (result.expectedReason && result.reason !== result.expectedReason)
          lines.push(`      reason: expected ${result.expectedReason}, got ${result.reason}`);
        for (const error of result.alignmentErrors) lines.push(`      ${error}`);
      }
    }
    if (report.passed !== report.total) failed = true;
  }

  if (only("injection")) {
    const report = await evaluateInjection();
    json["injection"] = report;
    lines.push("");
    lines.push(`INJECTION  ${report.attacks} documents carrying instructions, ${report.controls} ordinary quotes as controls`);
    lines.push(bar("containment failures", `${report.containmentFailures}   (this is the one that must be zero)`));
    lines.push(bar("detection recall", pct(report.detectionRecall)));
    lines.push(bar("controls that tripped the detector", String(report.falsePositives)));
    for (const [category, counts] of Object.entries(report.categoryRecall)) {
      lines.push(bar(`  ${category.toLowerCase().replace(/_/g, " ")}`, `${counts.found} of ${counts.expected}`));
    }
    if (args.has("--injection") || args.has("--verbose")) {
      for (const result of report.results.filter((r) => (r.hasInjection && !r.detected) || (!r.hasInjection && r.detected) || !r.contained)) {
        lines.push(`    ${result.id}  ${result.title}`);
        if (result.hasInjection && !result.detected) lines.push(`      not detected (contained anyway: ${result.contained})`);
        if (!result.hasInjection && result.detected) lines.push(`      control tripped: ${result.categoriesFound.join(", ")}`);
        for (const note of result.containmentNotes) lines.push(`      containment: ${note}`);
      }
    }
    // Detection may miss; containment may not, and a control that fires makes
    // the label meaningless. Only those two fail the gate.
    if (report.containmentFailures > 0 || report.falsePositives > 0) failed = true;
  }

  if (only("transfer")) {
    const report = await evaluateTransfer();
    json["transfer"] = report;
    const dollars = (cents: number): string => `$${Math.round(cents / 100).toLocaleString("en-US")}`;
    lines.push("");
    lines.push(`TRANSFER  ${report.documents} estimates labelled before they were read; reported, never gated`);
    lines.push(bar("totals read", `${report.totalsRead} of ${report.documents}`));
    lines.push(bar("itemisation level read", `${report.itemisationRead} of ${report.documents}`));
    lines.push(bar("priced lines read", `${pct(report.linesRead / report.workLines)}  (${report.linesRead} of ${report.workLines}; ${dollars(report.linesReadCents)} of ${dollars(report.workCents)})`));
    lines.push(bar("read lines mapped to their work", `${pct(report.mapped / report.mappable)}  (${report.mapped} of ${report.mappable}; ${dollars(report.mappedCents)} of ${dollars(report.mappableCents)})`));
    lines.push(bar("lines asserting work not proposed", `${report.linesWithAssertion}  (${dollars(report.assertedCents)})`));
    lines.push(bar("options or summaries read as work", `${report.nonWorkLinesRead}  (${dollars(report.nonWorkCentsRead)})`));
    lines.push(bar("work outside the taxonomy", `${report.outsideLines} lines, ${dollars(report.outsideCents)} of ${dollars(report.workCents)}`));
    lines.push(bar("proposed components found", `${pct(report.foundComponents / report.proposedComponents)}  (${report.foundComponents} of ${report.proposedComponents})`));
    lines.push(bar("documents fully read", `${report.fullyRead} of ${report.documents}`));
    if (args.has("--transfer") || args.has("--verbose")) {
      lines.push("");
      lines.push("  by format");
      for (const [tag, s] of Object.entries(report.byTag).sort(([a], [b]) => a.localeCompare(b))) {
        lines.push(
          bar(`  ${tag}`, `${s.documents} doc${s.documents === 1 ? "" : "s"}: lines read ${s.linesRead}/${s.workLines}, mapped ${s.mapped}/${s.mappable}, assertions ${s.assertions}`),
        );
      }
      lines.push("");
      lines.push("  outside the taxonomy");
      for (const [name, n] of Object.entries(report.outsideNames).sort(([, a], [, b]) => b - a)) lines.push(bar(`  ${name}`, String(n)));
      lines.push("");
      for (const result of report.results) {
        const flags: string[] = [];
        if (!result.totalRead) flags.push(`total ${result.actualTotalCents / 100} for ${result.totalCents / 100}`);
        if (!result.itemisationRead) flags.push(`itemisation ${result.actualItemisation}`);
        if (result.depositRead === false) flags.push("deposit missed");
        for (const line of result.lines) {
          if (line.kind === "work" && !line.read) flags.push(`unread L${line.line} "${line.excerpt.slice(0, 40)}"`);
          else if (line.kind === "work" && !line.mapped) flags.push(`L${line.line} missing ${line.missing.join(",")}`);
          if (line.asserted.length) flags.push(`L${line.line} asserts ${line.asserted.join(",")}`);
          if (["alternate", "summary", "waived"].includes(line.kind) && line.readAsWork) flags.push(`L${line.line} ${line.kind} read as work`);
        }
        if (result.missed.length) flags.push(`missed ${result.missed.join(",")}`);
        if (result.asserted.length) flags.push(`asserts ${result.asserted.join(",")}`);
        if (result.excludedAsserted.length) flags.push(`asserts excluded ${result.excludedAsserted.join(",")}`);
        lines.push(`    ${result.id}  ${result.fullyRead ? "read" : "    "}  ${result.title}`);
        for (const flag of flags) lines.push(`      ${flag}`);
      }
    }
  }

  if (only("lexicon")) {
    lines.push("");
    lines.push("ENGINE");
    lines.push(bar("taxonomy components", String(TAXONOMY_STATS.components)));
    lines.push(bar("lexical forms", String(TAXONOMY_STATS.lexicalForms)));
    lines.push(bar("phrases claimed by two components", String(AMBIGUOUS_PHRASES.size)));
    lines.push(bar("verification rules", String(RULE_IDS.length)));
    lines.push(bar("injection detectors", `${INJECTION_DETECTOR_COUNT} across ${INJECTION_CATEGORIES.length} categories`));
    json["engine"] = {
      ...TAXONOMY_STATS,
      rules: RULE_IDS.length,
      injectionDetectors: INJECTION_DETECTOR_COUNT,
      injectionCategories: INJECTION_CATEGORIES.length,
    };
  }

  process.stdout.write(`${lines.join("\n")}\n\n`);

  const jsonArg = process.argv.find((a) => a.startsWith("--json="));
  if (jsonArg) {
    await writeFile(jsonArg.slice("--json=".length), `${JSON.stringify(json, null, 2)}\n`, "utf8");
  }

  if (failed) {
    process.stdout.write("Regressions above.\n");
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
