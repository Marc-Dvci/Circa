import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CaseService, MemoryCaseRepository } from "#store";
import { createContext, type ServerContext } from "../apps/mcp-server/src/context.js";
import { startHttpServer, type RunningServer } from "../apps/mcp-server/src/http.js";
import { REQUIRED_PROTOCOL_VERSION } from "../apps/mcp-server/src/server.js";
import { TOOL_NAMES } from "../apps/mcp-server/src/tools.js";
import { UI_MIME_TYPE, VIEWS } from "../apps/mcp-server/src/ui/views.js";

/**
 * Conformance, against a real client over a real socket.
 *
 * The point of this file is that nothing in it is hand-rolled. It is the MCP
 * SDK's own `Client` and its own `StreamableHTTPClientTransport`, talking to the
 * server over a bound port, so what is asserted is the version the two sides
 * genuinely negotiated rather than a constant this repository chose. A test that
 * connected a hand-written client to a hand-written server would agree with
 * itself on any protocol version at all, including one Alexa+ rejects.
 */

let running: RunningServer;
let context: ServerContext;
let client: Client;
let transport: StreamableHTTPClientTransport;

beforeAll(async () => {
  context = await createContext({} as NodeJS.ProcessEnv, {
    service: new CaseService(new MemoryCaseRepository()),
  });
  running = await startHttpServer(context, { port: 0 });
  transport = new StreamableHTTPClientTransport(new URL(`${running.url}/mcp`));
  client = new Client({ name: "circa-conformance", version: "0.1.0" });
  await client.connect(transport);
});

afterAll(async () => {
  await client.close().catch(() => undefined);
  await running.close();
});

describe("streamable http conformance", () => {
  it("negotiates the protocol version Alexa+ requires", () => {
    const negotiated = client.getServerVersion();
    expect(negotiated?.name).toBe("circa");
    // `getServerCapabilities` is only populated after a real initialize round
    // trip, so its presence is itself part of the assertion.
    expect(client.getServerCapabilities()).toBeDefined();
    expect(transport.protocolVersion).toBe(REQUIRED_PROTOCOL_VERSION);
  });

  it("issues a session id and rejects a request that does not carry one", async () => {
    expect(transport.sessionId).toBeTruthy();
    const response = await fetch(`${running.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/list", params: {} }),
    });
    expect(response.status).toBe(400);
  });

  it("advertises the MCP Apps extension in its capabilities", () => {
    const capabilities = client.getServerCapabilities() as {
      extensions?: Record<string, { mimeTypes?: string[] }>;
    };
    const ui = capabilities.extensions?.["io.modelcontextprotocol/ui"];
    expect(ui).toBeDefined();
    expect(ui?.mimeTypes).toContain(UI_MIME_TYPE);
  });

  it("lists every tool with a description and an input schema", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    for (const tool of tools) {
      expect(tool.description, `${tool.name} has no description`).toBeTruthy();
      expect(tool.inputSchema, `${tool.name} has no input schema`).toBeDefined();
      // Amazon's guidance is that the model treats the schema as a promise, so a
      // tool that takes arguments must describe them rather than accept a bag.
      expect(tool.inputSchema.type).toBe("object");
    }
  });

  it("links tool results to a view with the nested _meta.ui.resourceUri", async () => {
    const { tools } = await client.listTools();
    const linked = tools.filter((t) => (t._meta as { ui?: { resourceUri?: string } })?.ui?.resourceUri);
    expect(linked.length).toBeGreaterThanOrEqual(12);
    const uris = new Set(VIEWS.map((v) => v.uri));
    for (const tool of linked) {
      const uri = (tool._meta as { ui: { resourceUri: string } }).ui.resourceUri;
      expect(uris, `${tool.name} points at an unregistered view`).toContain(uri);
      // The flat spelling is deprecated in the final SEP-1865 text.
      expect(tool._meta).not.toHaveProperty("ui/resourceUri");
    }
  });

  it("serves every view as an mcp-app resource that loads nothing", async () => {
    const { resources } = await client.listResources();
    expect(resources).toHaveLength(VIEWS.length);
    for (const view of VIEWS) {
      const read = await client.readResource({ uri: view.uri });
      const first = read.contents[0] as { mimeType?: string; text?: string; _meta?: { ui?: { csp?: { connectDomains?: string[]; resourceDomains?: string[] } } } };
      expect(first.mimeType).toBe(UI_MIME_TYPE);
      expect(first.text).toContain("<!doctype html>");
      expect(first._meta?.ui?.csp?.connectDomains).toEqual([]);
      expect(first._meta?.ui?.csp?.resourceDomains).toEqual([]);
      // The empty CSP is a claim about the document. If a view ever grows a
      // <script src> or an @import, this is where it is caught.
      expect(first.text).not.toMatch(/<script[^>]+src=|@import|<link[^>]+href=/i);
    }
  });

  it("runs the whole repair through the wire and refuses what it cannot attribute", async () => {
    const started = await client.callTool({
      name: "start_repair_case",
      arguments: { issueSummary: "A roofer says the chimney flashing has failed", trade: "roofing", postalCode: "02139" },
    });
    const caseId = (started.structuredContent as { caseId: string }).caseId;
    expect(caseId).toMatch(/^case_/);
    expect((started.content as { type: string }[])[0]?.type).toBe("text");

    const captured = await client.callTool({
      name: "capture_offer",
      arguments: {
        caseId,
        description: "They knocked on the door and said the flashing around the chimney has failed and water could get in tonight",
        companyName: "Apex Exteriors",
        quotedPrice: 6500,
        depositRequested: 3000,
        contractorFoundBy: "DOOR_KNOCK",
        urgencyClaim: "water could get in tonight",
      },
    });
    const verification = captured.structuredContent as { counts: { attention: number; verify: number }; speech: string };
    expect(verification.counts.attention + verification.counts.verify).toBeGreaterThan(0);
    expect(verification.speech).toMatch(/cannot|can't/i);

    const scope = await client.callTool({ name: "structure_scope", arguments: { caseId } });
    const scopeData = scope.structuredContent as { withheld: { what: string }[]; text: string };
    expect(scopeData.withheld.length).toBeGreaterThan(0);
    expect(scopeData.text).not.toContain("Apex");
    expect(scopeData.text).not.toContain("6,500");

    await client.callTool({
      name: "add_quote",
      arguments: {
        caseId,
        contractorName: "Nine Elms Exterior Surveys",
        source: "SECOND_OPINION",
        text: [
          "Remove and replace chimney step and counter flashing ............ $1,200.00",
          "Replace 8 damaged shingles at the chimney ...................... $   400.00",
          "Seal penetrations and haul away debris ......................... $   250.00",
          "Exclusions: decking replacement, gutters",
          "Total: $1,850.00",
        ].join("\n"),
      },
    });

    const compared = await client.callTool({ name: "compare_quotes", arguments: { caseId } });
    const comparison = compared.structuredContent as { identifiable: boolean; refusal?: string; notIdentifiableReason?: string };
    // The contractor's side is a spoken lump sum, so the engine must decline to
    // attribute the gap. This is the product's central claim, asserted over the
    // wire rather than in a unit test.
    expect(comparison.identifiable).toBe(false);
    expect(comparison.notIdentifiableReason).toBe("LUMP_SUM");
    expect(comparison.refusal).toMatch(/itemised/i);
    expect((compared._meta as { ui: { resourceUri: string } }).ui.resourceUri).toBe("ui://circa/comparison");
  });

  it("reports an unknown case as a spoken error that names no internal id", async () => {
    // Alexa+ functional requirements: surface no API codes, tool names, JSON or
    // internal ids in any customer-facing response. An error is a customer-facing
    // response, and this one used to read the case id back.
    const result = await client.callTool({ name: "get_verification_status", arguments: { caseId: "case_nope" } });
    expect(result.isError).toBe(true);
    const text = ((result.content as { text: string }[])[0] ?? { text: "" }).text;
    expect(text).toMatch(/do not have a record of that repair/i);
    expect(text).not.toContain("case_nope");
    expect(text).not.toMatch(/get_verification_status/);
  });

  it("records latency for every call it served", () => {
    const summary = context.metrics.summary();
    expect(summary.length).toBeGreaterThan(0);
    for (const entry of summary) {
      expect(entry.p95).toBeGreaterThanOrEqual(0);
      expect(entry.calls).toBeGreaterThan(0);
    }
  });
});
