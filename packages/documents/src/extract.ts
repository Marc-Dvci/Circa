import { readFile } from "node:fs/promises";
import { isolate, type IsolatedDocument } from "./isolate.js";

/**
 * Getting text out of a document.
 *
 * Two implementations, one interface, and the offline one is the default. A
 * judge on a clean clone with no AWS account runs the whole product; adding
 * credentials swaps the extractor and changes nothing else, which is the only
 * way to keep the cloud path honest — if the local path were a different code
 * route, the cloud path would be untested and the local path would be the
 * product.
 */

export interface ExtractionResult {
  text: string;
  pages?: number;
  /** Mean block confidence, where the extractor reports one. */
  confidence?: number;
  extractor: string;
  modelAssisted: boolean;
}

export interface DocumentExtractor {
  readonly name: string;
  supports(mediaType: string): boolean;
  extract(bytes: Uint8Array, mediaType: string): Promise<ExtractionResult>;
}

/** Plain text and Markdown. No cloud, no model, no cost. */
export class PlainTextExtractor implements DocumentExtractor {
  readonly name = "plain-text";
  supports(mediaType: string): boolean {
    return mediaType.startsWith("text/");
  }
  async extract(bytes: Uint8Array): Promise<ExtractionResult> {
    return {
      text: new TextDecoder().decode(bytes),
      extractor: this.name,
      modelAssisted: false,
    };
  }
}

/** The shape of the Textract client this adapter needs, so the adapter is testable without one. */
export interface TextractLike {
  send(command: unknown): Promise<{
    Blocks?: { BlockType?: string; Text?: string; Confidence?: number; Page?: number }[];
  }>;
}

export interface TextractCommandFactory {
  detectDocumentText(input: { Document: { Bytes: Uint8Array } }): unknown;
}

/**
 * Amazon Textract, `DetectDocumentText`.
 *
 * `AnalyzeExpense` is the obvious choice for a quote and is deliberately not
 * used: it returns a vendor's idea of line items, and CIRCA's whole argument is
 * that the line-item structure is the thing under examination. Taking Textract's
 * LINE blocks and running them through the same parser as a typed quote keeps
 * one trust boundary instead of two, and keeps the extraction auditable — the
 * page and line of every claim survive.
 */
export class TextractExtractor implements DocumentExtractor {
  readonly name = "aws-textract";
  constructor(
    private readonly client: TextractLike,
    private readonly commands: TextractCommandFactory,
  ) {}

  supports(mediaType: string): boolean {
    return mediaType === "application/pdf" || mediaType === "image/jpeg" || mediaType === "image/png";
  }

  async extract(bytes: Uint8Array): Promise<ExtractionResult> {
    const response = await this.client.send(this.commands.detectDocumentText({ Document: { Bytes: bytes } }));
    const lines = (response.Blocks ?? []).filter((b) => b.BlockType === "LINE");
    const confidences = lines.map((b) => b.Confidence).filter((c): c is number => typeof c === "number");
    return {
      text: lines.map((b) => b.Text ?? "").join("\n"),
      pages: Math.max(1, ...lines.map((b) => b.Page ?? 1)),
      ...(confidences.length
        ? { confidence: confidences.reduce((a, b) => a + b, 0) / confidences.length / 100 }
        : {}),
      extractor: this.name,
      modelAssisted: false,
    };
  }
}

export async function textractExtractor(): Promise<TextractExtractor> {
  const sdk = await import("@aws-sdk/client-textract");
  const client = new sdk.TextractClient({});
  return new TextractExtractor(client as unknown as TextractLike, {
    detectDocumentText: (input) => new sdk.DetectDocumentTextCommand(input as never),
  });
}

/**
 * Pick an extractor for a media type, preferring the ones that need nothing.
 *
 * `CIRCA_TEXTRACT=1` opts in. There is no automatic upgrade on finding
 * credentials: a demo that silently starts costing money and calling a region
 * because an unrelated environment variable was present is a demo nobody can
 * reason about.
 */
export async function chooseExtractor(
  mediaType: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DocumentExtractor> {
  const plain = new PlainTextExtractor();
  if (plain.supports(mediaType)) return plain;
  if (env["CIRCA_TEXTRACT"] === "1") return textractExtractor();
  throw new Error(
    `no offline extractor for ${mediaType}. Set CIRCA_TEXTRACT=1 with AWS credentials, or supply the quote as text.`,
  );
}

export async function ingestFile(
  path: string,
  sourceLabel: string,
  mediaType: IsolatedDocument["mediaType"] = "text/plain",
  env: NodeJS.ProcessEnv = process.env,
): Promise<IsolatedDocument> {
  const bytes = await readFile(path);
  const extractor = await chooseExtractor(mediaType, env);
  const result = await extractor.extract(bytes, mediaType);
  return isolate({
    sourceLabel,
    text: result.text,
    mediaType,
    extractor: result.extractor,
    modelAssisted: result.modelAssisted,
    ...(result.pages !== undefined ? { pages: result.pages } : {}),
    ...(result.confidence !== undefined ? { confidence: result.confidence } : {}),
  });
}
