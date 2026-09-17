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

/** The model id on the Bedrock API endpoint, which drops the version suffix `InvokeModel` carries. */
export const DEFAULT_ENDPOINT_MODEL_ID = "anthropic.claude-haiku-4-5";

/**
 * Bedrock's API endpoint, as a `BedrockLike`.
 *
 * Bedrock now serves Anthropic models over the Anthropic Messages API at
 * `<endpoint>/anthropic/v1/messages`, authenticated with a short-term bearer
 * token minted from the caller's AWS credentials, and this is the path an
 * account without a model-access agreement can use. The request body is the
 * one `InvokeModel` already builds, minus `anthropic_version` and plus `model`,
 * and the response body is byte-for-byte the same shape, so the two callers
 * above do not know which transport they are on. That is the point of keeping
 * the transport behind `send()`.
 */
export function bedrockEndpoint(
  endpoint: string,
  token: () => Promise<string>,
  fetchImpl: typeof fetch = fetch,
): BedrockLike {
  const base = endpoint.replace(/\/+$/, "");
  const post = async (path: string, extraHeaders: Record<string, string>, body: unknown): Promise<unknown> => {
    const response = await fetchImpl(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${await token()}`, ...extraHeaders },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`Bedrock endpoint answered ${response.status}: ${(await response.text()).slice(0, 400)}`);
    }
    return response.json();
  };
  return {
    async send(command: unknown): Promise<{ body?: Uint8Array }> {
      const { modelId, body } = command as { modelId: string; body: string };
      const {
        anthropic_version: _dropped,
        system,
        messages,
        max_tokens,
      } = JSON.parse(body) as {
        anthropic_version?: string;
        system: string;
        messages: { role: string; content: { type: string; text: string }[] }[];
        max_tokens: number;
      };

      // Anthropic models take the Messages API and answer in the shape
      // `InvokeModel` already returns. Every other family on the endpoint takes
      // chat completions, whose answer is folded into that same shape here, so
      // the callers stay ignorant of which model rephrased their sentence. The
      // product never depended on that: the model proposes and the code decides,
      // whatever the model is.
      const answer = modelId.startsWith("anthropic.")
        ? await post("/anthropic/v1/messages", { "anthropic-version": "2023-06-01" }, { model: modelId, system, messages, max_tokens })
        : toMessagesShape(
            await post(
              "/v1/chat/completions",
              {},
              {
                model: modelId,
                max_tokens,
                messages: [
                  { role: "system", content: system },
                  ...messages.map((m) => ({ role: m.role, content: m.content.map((c) => c.text).join("\n") })),
                ],
              },
            ),
          );
      return { body: new TextEncoder().encode(JSON.stringify(answer)) };
    },
  };
}

/** A chat-completions answer, in the Messages shape `BedrockClient.complete` reads. */
function toMessagesShape(completion: unknown): { content: { type: "text"; text: string }[] } {
  const text = (completion as { choices?: { message?: { content?: string | null } }[] }).choices?.[0]?.message?.content ?? "";
  return { content: [{ type: "text", text }] };
}

export async function bedrockFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<BedrockClient | undefined> {
  if (env["CIRCA_BEDROCK"] !== "1") return undefined;
  const region = env["AWS_REGION"];

  // CIRCA_BEDROCK_ENDPOINT=https://bedrock-mantle.us-east-1.api.aws selects the
  // API endpoint; without it, InvokeModel through the SDK as before.
  const endpoint = env["CIRCA_BEDROCK_ENDPOINT"];
  if (endpoint) {
    const { getToken } = await import("@aws/bedrock-token-generator");
    const { fromNodeProviderChain } = await import("@aws-sdk/credential-providers");
    // The same provider chain every other AWS call here uses, signed into a
    // twelve-hour bearer token. Minted per call, which costs nothing (it is a
    // local signature) and means a rotated credential is picked up without a
    // restart.
    const credentials = fromNodeProviderChain();
    const token = (): Promise<string> => getToken({ credentials, region: region ?? "us-east-1" });
    return new BedrockClient(
      bedrockEndpoint(endpoint, token),
      { invokeModel: (input) => input },
      { modelId: env["CIRCA_MODEL_ID"] ?? DEFAULT_ENDPOINT_MODEL_ID },
    );
  }

  const sdk = await import("@aws-sdk/client-bedrock-runtime");
  const client = new sdk.BedrockRuntimeClient({ ...(region ? { region } : {}) });
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
