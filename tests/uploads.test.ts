import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CaseService, MemoryCaseRepository } from "#store";
import { S3Uploads, TextractExtractor, mediaTypeFor, type S3Like, type TextractLike } from "#documents";
import { createContext } from "../apps/mcp-server/src/context.js";
import { startHttpServer, type RunningServer } from "../apps/mcp-server/src/http.js";
import { INDEPENDENT_QUOTE, ITEMISED_REQUOTE } from "../tools/demo/src/script.js";

/**
 * Uploaded documents: S3 by key, then the extractor, then the same parser.
 *
 * The S3 double stores objects in a map and counts requests, so a refusal can
 * be shown to happen before anything is sent. The Textract double returns the
 * re-quote's lines as LINE blocks, the shape `DetectDocumentText` answers with.
 */

type Command = { kind: "get" | "put"; Bucket: string; Key: string; Body?: Uint8Array; ContentType?: string };

class S3Double implements S3Like {
  readonly objects = new Map<string, { body: Uint8Array; contentType: string }>();
  requests = 0;
  async send(command: unknown) {
    this.requests += 1;
    const c = command as Command;
    if (c.kind === "put") {
      this.objects.set(c.Key, { body: c.Body!, contentType: c.ContentType! });
      return {};
    }
    const found = this.objects.get(c.Key);
    if (!found) throw new Error("NoSuchKey");
    return {
      ContentType: found.contentType,
      ContentLength: found.body.byteLength,
      Body: { transformToByteArray: async () => found.body },
    };
  }
}

const commands = {
  getObject: (input: { Bucket: string; Key: string }) => ({ kind: "get", ...input }),
  putObject: (input: { Bucket: string; Key: string; Body: Uint8Array; ContentType: string }) => ({ kind: "put", ...input }),
};

const textract: TextractLike = {
  async send() {
    return {
      Blocks: ITEMISED_REQUOTE.split("\n")
        .filter((line) => line.trim().length > 0)
        .map((Text) => ({ BlockType: "LINE", Text, Confidence: 99, Page: 1 })),
    };
  },
};

describe("S3Uploads", () => {
  it("stores under the user's prefix and reads the object back by key", async () => {
    const s3 = new S3Double();
    const uploads = new S3Uploads(s3, commands, "bucket");
    const key = await uploads.put("user_a", new Uint8Array([1, 2, 3]), "image/png");
    expect(key).toMatch(/^uploads\/user_a\/[0-9a-f-]{36}\.png$/);
    const read = await uploads.read("user_a", key);
    expect([...read.bytes]).toEqual([1, 2, 3]);
    expect(read.mediaType).toBe("image/png");
  });

  it("refuses another user's key before sending a request", async () => {
    const s3 = new S3Double();
    const uploads = new S3Uploads(s3, commands, "bucket");
    const key = await uploads.put("user_a", new Uint8Array([1]), "image/png");
    const before = s3.requests;
    await expect(uploads.read("user_b", key)).rejects.toThrow(/uploaded yourself/);
    await expect(uploads.read("user_a", "uploads/user_a/../user_b/x.png")).rejects.toThrow(/uploaded yourself/);
    await expect(uploads.read("user_a", "uploads/user_a/")).rejects.toThrow(/uploaded yourself/);
    expect(s3.requests).toBe(before);
  });

  it("refuses a user id that would reach into another prefix", async () => {
    const uploads = new S3Uploads(new S3Double(), commands, "bucket");
    await expect(uploads.put("a/b", new Uint8Array([1]), "image/png")).rejects.toThrow(/cannot own uploads/);
  });

  it("takes the media type from the object, then from the extension", () => {
    expect(mediaTypeFor("x.bin", "application/pdf")).toBe("application/pdf");
    expect(mediaTypeFor("x.JPG")).toBe("image/jpeg");
    expect(mediaTypeFor("x.txt", "text/plain; charset=utf-8")).toBe("text/plain");
    expect(() => mediaTypeFor("x.docx")).toThrow(/cannot read it/);
  });
});

describe("add_quote with an uploaded photo, over MCP", () => {
  let running: RunningServer;
  let bare: RunningServer;
  let client: Client;
  let bareClient: Client;
  let uploads: S3Uploads;

  beforeAll(async () => {
    uploads = new S3Uploads(new S3Double(), commands, "bucket");
    const context = await createContext({} as NodeJS.ProcessEnv, {
      service: new CaseService(new MemoryCaseRepository()),
      uploads,
      extractor: new TextractExtractor(textract, { detectDocumentText: (input) => input }),
    });
    running = await startHttpServer(context, { port: 0 });
    client = new Client({ name: "circa-uploads", version: "0.1.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${running.url}/mcp`)));

    const bareContext = await createContext({} as NodeJS.ProcessEnv, {
      service: new CaseService(new MemoryCaseRepository()),
      uploads: undefined,
    });
    bare = await startHttpServer(bareContext, { port: 0 });
    bareClient = new Client({ name: "circa-uploads-bare", version: "0.1.0" });
    await bareClient.connect(new StreamableHTTPClientTransport(new URL(`${bare.url}/mcp`)));
  });

  afterAll(async () => {
    await client.close().catch(() => undefined);
    await bareClient.close().catch(() => undefined);
    await running.close();
    await bare.close();
  });

  type Result = { content: { text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };
  const call = async (c: Client, name: string, args: Record<string, unknown>) =>
    (await c.callTool({ name, arguments: args })) as Result;

  it("offers documentKey only when uploads are configured", async () => {
    const withUploads = (await client.listTools()).tools.find((t) => t.name === "add_quote")!;
    const without = (await bareClient.listTools()).tools.find((t) => t.name === "add_quote")!;
    expect(Object.keys(withUploads.inputSchema.properties ?? {})).toContain("documentKey");
    expect(withUploads.inputSchema.required ?? []).not.toContain("text");
    expect(Object.keys(without.inputSchema.properties ?? {})).not.toContain("documentKey");
    expect(without.inputSchema.required ?? []).toContain("text");
  });

  it("gives the typed demo's answer from a photographed re-quote", async () => {
    const opened = await call(client, "start_repair_case", {
      issueSummary: "A roofer says the chimney flashing has failed",
      trade: "roofing",
    });
    const caseId = String(opened.structuredContent?.["caseId"]);
    const b = await call(client, "add_quote", {
      caseId,
      contractorName: "Nine Elms Exterior Surveys",
      source: "SECOND_OPINION",
      text: INDEPENDENT_QUOTE,
    });
    const key = await uploads.put("user_demo", new Uint8Array([137, 80, 78, 71]), "image/png");
    const a = await call(client, "add_quote", {
      caseId,
      contractorName: "Apex Exteriors",
      source: "CONTRACTOR",
      documentKey: key,
    });
    expect(a.isError).toBeFalsy();
    expect(a.content[0]!.text).toMatch(/itemised across 5 lines/);
    const compared = await call(client, "compare_quotes", {
      caseId,
      quoteAId: String(a.structuredContent?.["quoteId"]),
      quoteBId: String(b.structuredContent?.["quoteId"]),
    });
    const speech = compared.content[0]!.text;
    for (const figure of ["$4,030", "$420", "$200", "Seal penetrations"]) expect(speech).toContain(figure);
  });

  it("refuses text and an upload together, and another user's key", async () => {
    const opened = await call(client, "start_repair_case", { issueSummary: "A leak under the sink", trade: "plumbing" });
    const caseId = String(opened.structuredContent?.["caseId"]);
    const key = await uploads.put("user_demo", new Uint8Array([1]), "image/png");
    const both = await call(client, "add_quote", { caseId, text: INDEPENDENT_QUOTE, documentKey: key });
    expect(both.isError).toBe(true);
    const foreign = await call(client, "add_quote", { caseId, documentKey: "uploads/someone_else/x.png" });
    expect(foreign.isError).toBe(true);
    expect(foreign.content[0]!.text).toMatch(/uploaded yourself/);
  });
});
