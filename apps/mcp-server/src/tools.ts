import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { CaseSnapshot } from "#domain";
import { assertSafeLanguage, formatCents, type OfferContext, type PaymentMethod, type Trade } from "#schema";
import { findAnchoring } from "#normalizer";
import { runVerification } from "#verification";
import {
  presentChange,
  presentComparison,
  presentDossier,
  presentProviders,
  presentVerification,
  shortTitle,
  type ViewPayload,
} from "#agent";
import { DemoProviderRepository } from "#providers";
import type { ServerContext } from "./context.js";

/**
 * The tool surface.
 *
 * Fifteen tools, each one a translation of a single `CaseService` operation into
 * the vocabulary a model uses when a person is talking about a repair. There is
 * no logic in this file that a judge would have to read to know what the product
 * does — no thresholds, no wording, no arithmetic on money beyond the dollars-to-
 * cents conversion at the boundary. That is on purpose: the CLI and the
 * simulator call the same service, so a rule that lived here would be a rule
 * only the MCP path had.
 *
 * Two conventions, both of which are promises to the model:
 *
 * **Money crosses this boundary in dollars.** A model that has just heard
 * "six thousand five hundred" will emit `6500`, and a schema that says cents
 * would be a schema the model quietly violates by a factor of a hundred. Dollars
 * in, integer cents one line later, and nothing downstream ever sees a float.
 *
 * **Every input is honoured.** Amazon's guidance is explicit that the model
 * treats an MCP schema as a promise, so there is no field here the service
 * ignores. Where the product cannot do something, there is no parameter for it.
 */

const CENTS = 100;
const dollarsToCents = (dollars: number): number => Math.round(dollars * CENTS);

const TradeEnum = z.enum(["roofing", "plumbing", "electrical", "hvac", "general", "unknown"]);
const PaymentEnum = z.enum(["CASH", "CHECK", "CARD", "WIRE", "ACH", "CONTRACTOR_FINANCING", "UNSPECIFIED"]);

/**
 * The output contract, shared by every tool.
 *
 * Loose on purpose: each tool adds fields its view needs, and a host that only
 * knows these five gets a complete, speakable answer from any of them. `speech`
 * is the whole product on a device with no screen, so it is required rather than
 * optional, and no tool returns a result without one.
 */
const PayloadSchema = z
  .object({
    view: z.string().describe("The MCP App resource that renders this result."),
    caseId: z.string(),
    headline: z.string().describe("Four to six words, for a screen read from across a room."),
    speech: z.string().describe("What to say. Complete on its own: voice-only is the baseline, not a fallback."),
    rows: z.array(z.object({ label: z.string(), value: z.string(), attention: z.boolean().optional() })),
    actions: z.array(z.object({ label: z.string(), tool: z.string(), arguments: z.record(z.string(), z.unknown()) })),
    refusal: z.string().optional().describe("What CIRCA cannot say from this record, and what would make it answerable."),
  })
  .catchall(z.unknown());

type Registrar = (context: ServerContext) => void;

function toResult(payload: ViewPayload): CallToolResult {
  return {
    content: [{ type: "text", text: payload.speech }],
    structuredContent: payload as unknown as Record<string, unknown>,
    // SEP-1865: the tool names the view that should render it. The flat
    // `_meta["ui/resourceUri"]` spelling is the deprecated one and is not used.
    _meta: { ui: { resourceUri: payload.view } },
  };
}

function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text: assertSafeLanguage(text) }] };
}

export function registerTools(server: McpServer, context: ServerContext): void {
  const { service, providers, metrics } = context;

  /** Time every handler, and make a thrown error a spoken sentence rather than a stack trace. */
  const timed =
    <A>(name: string, handler: (args: A) => Promise<CallToolResult>) =>
    async (args: A): Promise<CallToolResult> => {
      const started = performance.now();
      let ok = true;
      try {
        return await handler(args);
      } catch (error) {
        ok = false;
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `I could not do that: ${message}` }],
          isError: true,
        };
      } finally {
        metrics.record({ tool: name, ms: performance.now() - started, at: context.clock(), ok });
      }
    };

  const snapshot = async (caseId: string): Promise<CaseSnapshot> => {
    const found = await service.snapshot(caseId);
    if (!found) throw new Error(`I do not have a repair with the reference ${caseId}`);
    return found;
  };

  const verificationPayload = async (caseId: string): Promise<ViewPayload> => {
    const snap = await snapshot(caseId);
    return presentVerification(snap, runVerification(snap));
  };

  // ── opening a case ────────────────────────────────────────────────────────

  server.registerTool(
    "start_repair_case",
    {
      title: "Start a repair case",
      description:
        "Open a persistent record for a home repair the customer is deciding about. Use this the first time a repair, quote or contractor visit comes up. Everything else in this add-on hangs off the caseId this returns, and the record survives across conversations.",
      inputSchema: {
        issueSummary: z.string().min(3).describe("What the customer says is wrong, in their words."),
        trade: TradeEnum.optional().describe("Leave unset if the customer has not said."),
        postalCode: z.string().optional().describe("Used only to find local assessors."),
      },
      outputSchema: PayloadSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      _meta: { ui: { resourceUri: "ui://circa/verification" } },
    },
    timed("start_repair_case", async ({ issueSummary, trade, postalCode }) => {
      const repair = await service.startCase({
        userId: context.userId,
        issueSummary,
        ...(trade ? { trade: trade as Trade } : {}),
        ...(postalCode ? { postalCode } : {}),
      });
      const payload = await verificationPayload(repair.id);
      payload.speech = "I have opened a record for this repair. Tell me what you have been offered, and what they want for it.";
      return toResult(payload);
    }),
  );

  server.registerTool(
    "capture_offer",
    {
      title: "Record what a contractor offered",
      description:
        "Record a home-service offer or quote the customer wants to evaluate before deciding whether to proceed: what the contractor says is wrong, what they propose, the price and any deposit. Returns the checklist of what has and has not been established. Prices are in dollars.",
      inputSchema: {
        caseId: z.string(),
        description: z.string().min(3).describe("What the contractor said, in the customer's words. Stored verbatim."),
        contractorName: z.string().optional(),
        companyName: z.string().optional(),
        quotedPrice: z.number().nonnegative().optional().describe("Dollars, not cents."),
        depositRequested: z.number().nonnegative().optional().describe("Dollars, not cents."),
        urgencyClaim: z.string().optional().describe("Any claim about how soon a decision is needed, verbatim."),
        contractorFoundBy: z
          .enum(["DOOR_KNOCK", "PHONE_CALL", "REFERRAL", "SEARCH", "MARKETPLACE", "REPEAT"])
          .optional()
          .describe("How the customer came to be talking to this contractor."),
        trade: TradeEnum.optional(),
      },
      outputSchema: PayloadSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      _meta: { ui: { resourceUri: "ui://circa/verification" } },
    },
    timed("capture_offer", async (args) => {
      const contextPatch: Partial<OfferContext> = {};
      if (args.urgencyClaim) contextPatch.urgencyClaim = args.urgencyClaim;
      if (args.contractorFoundBy) contextPatch.contractorFoundBy = args.contractorFoundBy;
      if (args.contractorFoundBy === "DOOR_KNOCK" || args.contractorFoundBy === "PHONE_CALL") {
        contextPatch.solicited = false;
      }
      await service.captureOffer({
        caseId: args.caseId,
        description: args.description,
        ...(args.contractorName ? { contractorName: args.contractorName } : {}),
        ...(args.companyName ? { companyName: args.companyName } : {}),
        ...(args.quotedPrice !== undefined ? { quotedPrice: dollarsToCents(args.quotedPrice) } : {}),
        ...(args.depositRequested !== undefined ? { depositRequested: dollarsToCents(args.depositRequested) } : {}),
        ...(args.trade ? { trade: args.trade as Trade } : {}),
        context: contextPatch,
      });
      return toResult(await verificationPayload(args.caseId));
    }),
  );

  // ── verification ──────────────────────────────────────────────────────────

  server.registerTool(
    "get_verification_status",
    {
      title: "What has and has not been established",
      description:
        "Return the checklist for a repair case: which conditions have been checked, which are unresolved, and what published consumer guidance each one comes from. There is no score and no risk rating; every item is a named check over a recorded fact.",
      inputSchema: { caseId: z.string() },
      outputSchema: PayloadSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: { ui: { resourceUri: "ui://circa/verification" } },
    },
    timed("get_verification_status", async ({ caseId }) => toResult(await verificationPayload(caseId))),
  );

  server.registerTool(
    "answer_verification_question",
    {
      title: "Answer one of the open questions",
      description:
        "Record the customer's answer to something the checklist asked about. Only pass a field the customer actually answered: leaving one unset means 'not established', which is different from 'no', and the checklist treats the two differently.",
      inputSchema: {
        caseId: z.string(),
        writtenScopeProvided: z.boolean().optional().describe("Did they leave a written, itemised scope of work?"),
        licenceNumberProvided: z.boolean().optional(),
        licenceVerified: z.boolean().optional().describe("Only true if the customer checked it against a register."),
        insuranceEvidenceProvided: z.boolean().optional(),
        damageShownToCustomer: z.boolean().optional().describe("Were they shown the damage, in person or in a photograph?"),
        decisionRequestedBy: z.enum(["IMMEDIATELY", "TODAY", "THIS_WEEK", "NO_DEADLINE"]).optional(),
        solicited: z.boolean().optional().describe("Did the customer contact them first?"),
        independentUrgencyConfirmation: z
          .boolean()
          .optional()
          .describe("Has an independent party — a utility, an insurer, a fire service — called this urgent?"),
        paymentMethodsRequested: z.array(PaymentEnum).optional(),
      },
      outputSchema: PayloadSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: { ui: { resourceUri: "ui://circa/verification" } },
    },
    timed("answer_verification_question", async ({ caseId, ...answers }) => {
      const patch: Partial<OfferContext> = {};
      for (const [key, value] of Object.entries(answers)) {
        if (value === undefined) continue;
        (patch as Record<string, unknown>)[key] = key === "paymentMethodsRequested" ? (value as PaymentMethod[]) : value;
      }
      await service.answerVerification({ caseId, answers: patch });
      return toResult(await verificationPayload(caseId));
    }),
  );

  // ── the neutral scope and the second opinion ──────────────────────────────

  server.registerTool(
    "structure_scope",
    {
      title: "Prepare an independent assessment request",
      description:
        "Turn what the first contractor said into a request an independent assessor can answer without being told the answer. Returns what will be sent and, separately, what was deliberately withheld from it: the proposed remedy, the price and the first contractor's name.",
      inputSchema: { caseId: z.string() },
      outputSchema: PayloadSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: { ui: { resourceUri: "ui://circa/scope" } },
    },
    timed("structure_scope", async ({ caseId }) => {
      const scope = await service.structureScope(caseId);
      const snap = await snapshot(caseId);
      const offer = snap.offers.at(-1)!;
      // The guard runs on every call rather than in the tests alone: a scope
      // that leaked the price would still read perfectly well, so nothing else
      // would notice.
      const leaks = findAnchoring(scope, offer);
      if (leaks.length > 0) throw new Error(`the assessment request would have carried the first opinion: ${leaks.join("; ")}`);

      const payload: ViewPayload = {
        view: "ui://circa/scope",
        caseId,
        headline: `${scope.inspectLabels.length} things to look at`,
        speech: assertSafeLanguage(
          `I have written the request so it says what to look at and not what to conclude. It asks for ${scope.inspectLabels
            .slice(0, 3)
            .join(", ")}${scope.inspectLabels.length > 3 ? " and more" : ""}, and it leaves out ${scope.withheld.length} thing${scope.withheld.length === 1 ? "" : "s"} that would have told the assessor what the first contractor already decided.`,
        ),
        rows: scope.withheld.map((w) => ({ label: "Left out", value: w.what })),
        actions: [
          { label: "Find someone", tool: "find_independent_professionals", arguments: { caseId } },
          { label: "Read the request", tool: "get_repair_dossier", arguments: { caseId } },
        ],
        refusal:
          scope.withheld.length > 0
            ? `Withheld because ${scope.withheld[0]!.why}. A second opinion that is given the first one is not a second opinion.`
            : undefined,
        inspect: scope.inspectLabels,
        requirements: scope.requirements,
        withheld: scope.withheld,
        text: scope.text,
      };
      return toResult(payload);
    }),
  );

  server.registerTool(
    "find_independent_professionals",
    {
      title: "Find someone to give a second opinion",
      description:
        "Find businesses that could assess this repair independently. Ordered by how little the assessor stands to gain from the finding: a firm that sells assessments and not repairs comes first, ahead of a better-reviewed firm that would also quote for the work. Results come from a simulated directory, and say so.",
      inputSchema: {
        caseId: z.string(),
        postalCode: z.string().optional().describe("Defaults to the one on the case."),
        limit: z.number().int().min(1).max(10).optional(),
        independentOnly: z.boolean().optional().describe("Only businesses that do not also sell the repair."),
      },
      outputSchema: PayloadSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
      _meta: { ui: { resourceUri: "ui://circa/providers" } },
    },
    timed("find_independent_professionals", async ({ caseId, postalCode, limit, independentOnly }) => {
      const snap = await snapshot(caseId);
      const matches = await providers.find({
        trade: snap.case.trade,
        ...(postalCode ?? snap.case.postalCode ? { postalCode: postalCode ?? snap.case.postalCode! } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(independentOnly !== undefined ? { independentOnly } : {}),
      });
      const notice =
        providers instanceof DemoProviderRepository ? await providers.notice() : providers.describe();
      return toResult(presentProviders(caseId, matches, notice));
    }),
  );

  server.registerTool(
    "request_second_opinion",
    {
      title: "Send the assessment request",
      description:
        "Send the independent assessment request to a chosen provider. The request that goes out is the neutral one: it does not carry the first contractor's diagnosis, price or name.",
      inputSchema: { caseId: z.string(), providerId: z.string() },
      outputSchema: PayloadSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      _meta: { ui: { resourceUri: "ui://circa/verification" } },
    },
    timed("request_second_opinion", async ({ caseId, providerId }) => {
      const provider = await providers.get(providerId);
      if (!provider) throw new Error(`I do not have a provider with the reference ${providerId}`);
      const scope = await service.structureScope(caseId);
      await service.requestSecondOpinion({
        caseId,
        providerId,
        providerName: provider.name,
        scopeText: scope.text,
      });
      const payload = await verificationPayload(caseId);
      payload.speech = assertSafeLanguage(
        `Sent to ${provider.name}. They usually respond within ${provider.responseHours} hours, and their next availability is ${
          provider.nextAvailableDays <= 1 ? "tomorrow" : `in ${provider.nextAvailableDays} days`
        }. The request does not mention the first quote${provider.assessmentFeeCents > 0 ? `. Their assessment fee is ${formatCents(provider.assessmentFeeCents)}` : " and their assessment is free"}.`,
      );
      return toResult(payload);
    }),
  );

  // ── quotes ────────────────────────────────────────────────────────────────

  server.registerTool(
    "add_quote",
    {
      title: "Add a written quote",
      description:
        "Add the text of a written quote or estimate to the case. The text is parsed into line items, amounts, exclusions and a total by code, never by a language model, because everything downstream treats the parsed result as fact.",
      inputSchema: {
        caseId: z.string(),
        text: z.string().min(10).describe("The quote as written, including line items and amounts."),
        contractorName: z.string().optional(),
        source: z
          .enum(["CONTRACTOR", "SECOND_OPINION", "MARKETPLACE"])
          .optional()
          .describe("Where it came from. Defaults to SECOND_OPINION."),
        requestId: z.string().optional().describe("The assessment request this answers, if any."),
      },
      outputSchema: PayloadSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      _meta: { ui: { resourceUri: "ui://circa/verification" } },
    },
    timed("add_quote", async ({ caseId, text, contractorName, source, requestId }) => {
      const quote = await service.addQuote({
        caseId,
        text,
        source: source ?? "SECOND_OPINION",
        ...(contractorName ? { contractorName } : {}),
        ...(requestId ? { requestId } : {}),
      });
      const snap = await snapshot(caseId);
      const payload = presentVerification(snap, runVerification(snap));
      const level = quote.itemisation?.level ?? "LUMP_SUM";
      payload.speech = assertSafeLanguage(
        `Added${contractorName ? ` ${contractorName}` : ""} at ${formatCents(quote.total)}, ${
          level === "ITEMISED"
            ? `itemised across ${quote.lineItems.length} lines`
            : level === "PARTIAL"
              ? `partly itemised: ${Math.round((quote.itemisation?.coverage ?? 0) * 100)} per cent of the total is attached to specific lines`
              : "as a single price for everything it describes"
        }.${snap.quotes.length >= 2 ? " Say compare the quotes when you are ready." : ""}`,
      );
      payload["quoteId"] = quote.id;
      return toResult(payload);
    }),
  );

  server.registerTool(
    "compare_quotes",
    {
      title: "Compare two quotes",
      description:
        "Compare two quotes on the work they describe rather than on their totals. Reports which work is in both, which is in one, and how much of the price difference the two documents can actually account for. Where they cannot account for it, this says so and says what would make it answerable.",
      inputSchema: {
        caseId: z.string(),
        quoteAId: z.string().optional().describe("Defaults to the contractor's quote."),
        quoteBId: z.string().optional().describe("Defaults to the independent one."),
      },
      outputSchema: PayloadSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: { ui: { resourceUri: "ui://circa/comparison" } },
    },
    timed("compare_quotes", async ({ caseId, quoteAId, quoteBId }) => {
      const { comparison, quoteA, quoteB } = await service.compare({
        caseId,
        ...(quoteAId ? { quoteAId } : {}),
        ...(quoteBId ? { quoteBId } : {}),
      });
      const snap = await snapshot(caseId);
      return toResult(presentComparison(snap, comparison, quoteA, quoteB));
    }),
  );

  server.registerTool(
    "accept_scope",
    {
      title: "Record what the customer accepted",
      description:
        "Record that the customer has accepted a quote. This writes the agreement baseline: the work, the exclusions and the total, as they stood at the moment of acceptance. It is written once and never rewritten, because every later change is measured against it.",
      inputSchema: { caseId: z.string(), quoteId: z.string() },
      outputSchema: PayloadSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      _meta: { ui: { resourceUri: "ui://circa/dossier" } },
    },
    timed("accept_scope", async ({ caseId, quoteId }) => {
      const baseline = await service.acceptScope({ caseId, quoteId });
      const snap = await snapshot(caseId);
      const payload = presentDossier(snap, runVerification(snap));
      payload.speech = assertSafeLanguage(
        `Recorded. You accepted ${formatCents(baseline.totalCents)} covering ${baseline.work.length} piece${baseline.work.length === 1 ? "" : "s"} of work${
          baseline.exclusions.length > 0 ? `, with ${baseline.exclusions.length} written exclusion${baseline.exclusions.length === 1 ? "" : "s"}` : ""
        }. If anyone asks for more money later, ask me and I will tell you whether it was in this.`,
      );
      return toResult(payload);
    }),
  );

  // ── change orders ─────────────────────────────────────────────────────────

  server.registerTool(
    "record_scope_change",
    {
      title: "Record a mid-job request for more money",
      description:
        "Record work a contractor has asked for after the customer accepted a scope, and review it against what was accepted. This is the tool for 'they say they found something and want another two thousand'. Amount is in dollars.",
      inputSchema: {
        caseId: z.string(),
        describedAs: z.string().min(3).describe("What they say they need to do, in the customer's words."),
        amount: z.number().nonnegative().optional().describe("Dollars, not cents."),
        writtenChangeOrderProvided: z.boolean().optional(),
        conditionDocumented: z.boolean().optional().describe("Were photographs taken of what they say they found?"),
        revisedCompletionDateGiven: z.boolean().optional(),
      },
      outputSchema: PayloadSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      _meta: { ui: { resourceUri: "ui://circa/change" } },
    },
    timed("record_scope_change", async ({ caseId, describedAs, amount, ...flags }) => {
      const { review } = await service.recordScopeChange({
        caseId,
        describedAs,
        ...(amount !== undefined ? { amountCents: dollarsToCents(amount) } : {}),
        ...flags,
      });
      const snap = await snapshot(caseId);
      return toResult(presentChange(snap, review));
    }),
  );

  server.registerTool(
    "review_scope_change",
    {
      title: "Check a change against the agreement",
      description:
        "Re-run the comparison between a proposed change and the scope the customer accepted, without recording anything new. Use this when the customer asks again later, or asks what they originally agreed to.",
      inputSchema: { caseId: z.string(), changeId: z.string().optional().describe("Defaults to the most recent.") },
      outputSchema: PayloadSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: { ui: { resourceUri: "ui://circa/change" } },
    },
    timed("review_scope_change", async ({ caseId, changeId }) => {
      const review = await service.reviewChange({ caseId, ...(changeId ? { changeId } : {}) });
      const snap = await snapshot(caseId);
      return toResult(presentChange(snap, review));
    }),
  );

  server.registerTool(
    "set_change_status",
    {
      title: "Update where a change has got to",
      description:
        "Mark a proposed change as documented in writing, approved by the customer, or declined. The change itself is never edited: its description and amount are what was proposed at the time.",
      inputSchema: {
        caseId: z.string(),
        changeId: z.string(),
        status: z.enum(["PROPOSED", "DOCUMENTED", "APPROVED", "DECLINED"]),
      },
      outputSchema: PayloadSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: { ui: { resourceUri: "ui://circa/change" } },
    },
    timed("set_change_status", async ({ caseId, changeId, status }) => {
      await service.setChangeStatus({ caseId, changeId, status });
      const review = await service.reviewChange({ caseId, changeId });
      const snap = await snapshot(caseId);
      const payload = presentChange(snap, review);
      payload.speech = assertSafeLanguage(
        `Noted as ${status.toLowerCase()}. ${payload.speech}`,
      );
      return toResult(payload);
    }),
  );

  // ── the record ────────────────────────────────────────────────────────────

  server.registerTool(
    "get_repair_dossier",
    {
      title: "Show the whole record",
      description:
        "Return everything recorded about a repair: the quotes, the accepted scope, any proposed changes, and the timeline of what happened when. This is what makes 'what did I actually agree to' answerable weeks later.",
      inputSchema: { caseId: z.string() },
      outputSchema: PayloadSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: { ui: { resourceUri: "ui://circa/dossier" } },
    },
    timed("get_repair_dossier", async ({ caseId }) => {
      const snap = await snapshot(caseId);
      return toResult(presentDossier(snap, runVerification(snap)));
    }),
  );

  server.registerTool(
    "list_repair_cases",
    {
      title: "List the customer's repairs",
      description: "List the repairs on record for this customer, most recently updated first. Use it when the customer refers to a repair without saying which.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    timed("list_repair_cases", async () => {
      const cases = await service.list(context.userId);
      if (cases.length === 0) return textResult("You have no repairs on record with me.");
      const lines = cases
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map((c) => `${shortTitle(c.issueSummary)} — ${c.status.toLowerCase().replace(/_/g, " ")} (${c.id})`);
      return textResult(`${cases.length} repair${cases.length === 1 ? "" : "s"}: ${lines.join("; ")}`);
    }),
  );

  server.registerTool(
    "delete_repair_case",
    {
      title: "Delete a repair record",
      description:
        "Delete a repair and everything recorded against it, including the timeline and the accepted scope. This cannot be undone, and after it the change-order review has nothing to compare against.",
      inputSchema: { caseId: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    timed("delete_repair_case", async ({ caseId }) => {
      const deleted = await service.deleteCase(caseId);
      return textResult(
        deleted
          ? "Deleted. The quotes, the accepted scope and the whole timeline are gone, and I cannot get them back."
          : `I have nothing on record under ${caseId}.`,
      );
    }),
  );
}

/** Every tool name, in the order they are registered. Used by the conformance suite. */
export const TOOL_NAMES = [
  "start_repair_case",
  "capture_offer",
  "get_verification_status",
  "answer_verification_question",
  "structure_scope",
  "find_independent_professionals",
  "request_second_opinion",
  "add_quote",
  "compare_quotes",
  "accept_scope",
  "record_scope_change",
  "review_scope_change",
  "set_change_status",
  "get_repair_dossier",
  "list_repair_cases",
  "delete_repair_case",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];
export type { Registrar };
