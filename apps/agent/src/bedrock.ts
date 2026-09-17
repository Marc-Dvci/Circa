import type { IsolatedDocument } from "#documents";
import { groundProposal, renderForModel, type ProposedQuote } from "#documents";
import type { Trade } from "#schema";
import type { ViewPayload } from "./present.js";
import { checkVoice, VOICE_SYSTEM_PROMPT, type VoiceCheck } from "./voice.js";

/**
 * Amazon Bedrock, in the two places a model earns its place.
 *
 * Not as the thing that decides. The rules, the comparison and every number in
 * this product are computed by code, and a model that went missing would change
 * nothing about what CIRCA concludes. It is used where the deterministic path is
 * genuinely weak:
 *
 * **Reading a document.** A photographed estimate with a two-column layout and a
 * handwritten total defeats a parser. A model proposes a structure; every line
 * of that proposal is then checked back against the document text and re-derived
 * by `normaliseLineItem`, so what survives is a structure the model found and the
 * engine agrees with. See `groundProposal`.
 *
 * **Saying it out loud.** The deterministic sentences are correct and stiff. A
 * model rephrases them, and the rephrasing is checked against the payload's own
 * numbers before it is spoken. See `checkVoice`.
 *
 * Both paths are optional and both are off by default. `CIRCA_BEDROCK=1` turns
 * them on; without it the product runs complete, which is the property that lets
 * a judge clone this repository and see the whole demo with no AWS account.
 */

export interface BedrockConfig {
  modelId: string;
  region?: string;
  maxTokens?: number;
}

export interface BedrockLike {
  send(command: unknown): Promise<{ body?: Uint8Array }>;
}

export interface BedrockCommandFactory {
  invokeModel(input: { modelId: string; contentType: string; accept: string; body: string }): unknown;
}

export const DEFAULT_MODEL_ID = "anthropic.claude-haiku-4-5-20251001-v1:0";

/**
 * A thin client over `InvokeModel`.
 *
 * The command factory is injected so the two callers below can be tested
 * against a scripted model — including a model that returns a line item the
 * document does not contain, which is the case that proves the grounding is load
 * bearing rather than decorative.
 */
export class BedrockClient {
  constructor(
    private readonly client: BedrockLike,
    private readonly commands: BedrockCommandFactory,
    private readonly config: BedrockConfig,
  ) {}

  async complete(system: string, user: string): Promise<string> {
    const response = await this.client.send(
      this.commands.invokeModel({
        modelId: this.config.modelId,
        contentType: "application/json",
        accept: "application/json",
        body: JSON.stringify({
          anthropic_version: "bedrock-2023-05-31",
          max_tokens: this.config.maxTokens ?? 1024,
          system,
          messages: [{ role: "user", content: [{ type: "text", text: user }] }],
        }),
      }),
    );
    const decoded = JSON.parse(new TextDecoder().decode(response.body ?? new Uint8Array())) as {
      content?: { type: string; text?: string }[];
    };
    return (decoded.content ?? [])
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("");
  }
}

export async function bedrockFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<BedrockClient | undefined> {
  if (env["CIRCA_BEDROCK"] !== "1") return undefined;
  const sdk = await import("@aws-sdk/client-bedrock-runtime");
  const client = new sdk.BedrockRuntimeClient({ ...(env["AWS_REGION"] ? { region: env["AWS_REGION"] } : {}) });
  return new BedrockClient(
    client as unknown as BedrockLike,
    { invokeModel: (input) => new sdk.InvokeModelCommand(input as never) },
    { modelId: env["CIRCA_MODEL_ID"] ?? DEFAULT_MODEL_ID },
  );
}

const EXTRACTION_SYSTEM = `You convert a home-repair quote into JSON. You do not evaluate it, advise on it, or comment on it.

Return exactly this shape and nothing else:
{"contractorName": string|null, "total": string|null, "deposit": string|null,
 "lineItems": [{"raw": string, "amount": string|null}], "exclusions": [string]}

"raw" must be copied from the document verbatim. Do not paraphrase, tidy, merge or split lines.
Amounts must be copied as they appear. Do not compute, infer, or fill in a missing one.
If the document does not say something, use null. Never guess.`;

export interface ExtractionOutcome {
  quote: ProposedQuote;
  grounded: ReturnType<typeof groundProposal>;
  /** The nonce the document envelope closed with. Asserted by the injection corpus. */
  nonce: string;
}

/**
 * Read a document with the model, then refuse to believe the parts of it that
 * are not in the document.
 *
 * The document goes in as a *user* message inside a nonce-delimited envelope,
 * never as a system instruction, and the returned structure is filtered by
 * `groundProposal` before anything else sees it. The rejection list is returned
 * rather than logged, because a proposal silently dropped is a defect that never
 * surfaces.
 */
export async function extractQuoteWithModel(
  bedrock: BedrockClient,
  document: IsolatedDocument,
  trade: Trade,
  quoteId: string,
): Promise<ExtractionOutcome> {
  const envelope = renderForModel(document, "Convert the following home-repair document into the JSON structure described.");
  const raw = await bedrock.complete(EXTRACTION_SYSTEM, envelope.text);
  const json = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
  let proposal: ProposedQuote;
  try {
    proposal = JSON.parse(json) as ProposedQuote;
  } catch {
    proposal = {};
  }
  return {
    quote: proposal,
    grounded: groundProposal(proposal, document, trade, quoteId),
    nonce: envelope.nonce,
  };
}

/** Rephrase for voice, then check the rephrasing against the payload's own numbers. */
export async function speakWithModel(bedrock: BedrockClient, payload: ViewPayload): Promise<VoiceCheck> {
  const generated = await bedrock.complete(
    VOICE_SYSTEM_PROMPT,
    JSON.stringify({ speech: payload.speech, rows: payload.rows, refusal: payload.refusal ?? null }),
  );
  return checkVoice(generated.trim(), payload);
}
