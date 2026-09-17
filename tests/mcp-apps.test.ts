import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { CaseService, MemoryCaseRepository } from "#store";
import { createContext } from "../apps/mcp-server/src/context.js";
import { startHttpServer, type RunningServer } from "../apps/mcp-server/src/http.js";
import { ViewHost, type DisplayMode, type WireEntry } from "../apps/simulator/src/host.js";
import { ITEMISED_REQUOTE, INDEPENDENT_QUOTE } from "../tools/demo/src/script.js";

/**
 * MCP Apps, both halves, driven against each other.
 *
 * `apps/mcp-server/src/ui/runtime.ts` runs inside the view.
 * `apps/simulator/src/host.ts` runs inside the host.
 * They were written from SEP-1865 separately, and until this file existed the
 * claim that they implement it was a claim about two files nobody had ever run
 * together — which is the same shape of mistake as a hand-rolled client agreeing
 * with a hand-rolled server, and this project has a rule about that.
 *
 * So: a real MCP server on a real socket, real tool results, the real view HTML
 * fetched with `resources/read`, executed by a real DOM, with the real host on
 * the other end of `postMessage`. Every button pressed here is a button a person
 * presses on an Echo Show.
 *
 * **Two jsdom limitations are worked around, and neither touches the protocol.**
 * jsdom does not implement `srcdoc`, so the view markup is installed with
 * `document.write` instead — the same bytes, a different way in. And jsdom does
 * not populate `MessageEvent.source`, which is the identity the host checks, so
 * a listener registered ahead of the host restores it. That check is tested
 * directly and separately, on fabricated events, so it is not the thing the
 * workaround is hiding.
 */

interface Frame {
  window: JSDOM["window"];
  iframe: HTMLIFrameElement;
  host: ViewHost;
  events: {
    resizes: number[];
    messages: string[];
    contexts: string[];
    links: string[];
    displayModes: DisplayMode[];
  };
  /** Wait for the message round trips to drain. */
  settle: (ticks?: number) => Promise<void>;
  document: Document;
  /** Run a snippet inside the view, to drive a request no button sends. */
  inView: (script: string) => Promise<unknown>;
  dispose: () => void;
}

let running: RunningServer;
let client: Client;
let caseId: string;
const results = new Map<string, CallToolResult>();
const viewHtml = new Map<string, string>();

async function call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  if (result.isError) throw new Error(`${name}: ${(result.content as { text: string }[])[0]?.text ?? "failed"}`);
  results.set(name, result);
  return result;
}

function viewUriOf(result: CallToolResult): string {
  const uri = (result._meta as { ui?: { resourceUri?: string } } | undefined)?.ui?.resourceUri;
  if (!uri) throw new Error("result carries no _meta.ui.resourceUri");
  return uri;
}

async function html(uri: string): Promise<string> {
  const cached = viewHtml.get(uri);
  if (cached) return cached;
  const read = await client.readResource({ uri });
  const text = (read.contents[0] as { text?: string }).text ?? "";
  viewHtml.set(uri, text);
  return text;
}

/**
 * A view, running.
 *
 * The host page is a jsdom document; the view is an iframe inside it carrying
 * the exact HTML the MCP server served. `runScripts: "dangerously"` is what
 * makes the runtime execute — on a device the view is sandboxed and this
 * document is the sandbox.
 */
async function mount(uri: string): Promise<Frame> {
  const markup = await html(uri);
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    runScripts: "dangerously",
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  const window = dom.window;
  const document = window.document as unknown as Document;
  const iframe = document.createElement("iframe");
  document.body.appendChild(iframe);

  const events: Frame["events"] = { resizes: [], messages: [], contexts: [], links: [], displayModes: [] };

  // jsdom leaves MessageEvent.source null. Restore it before the host looks, and
  // note that this is the only thing standing in for the browser's own identity.
  window.addEventListener(
    "message",
    (event: MessageEvent) => {
      if (event.source === null) {
        Object.defineProperty(event, "source", { value: iframe.contentWindow, configurable: true });
      }
    },
    true,
  );

  const host = new ViewHost(
    {
      callTool: async (name, args) => call(name, args),
      requestDisplayMode: (mode) => {
        const granted: DisplayMode = mode === "pip" ? "inline" : mode;
        events.displayModes.push(granted);
        return granted;
      },
      message: (text) => events.messages.push(text),
      updateModelContext: (text) => events.contexts.push(text),
      openLink: (url) => {
        events.links.push(url);
        return false;
      },
      resize: (height) => events.resizes.push(height),
    },
    window as unknown as Window,
  );
  host.setFrame(iframe);

  const inner = iframe.contentDocument!;
  inner.open();
  inner.write(markup);
  inner.close();

  const settle = async (ticks = 6): Promise<void> => {
    for (let i = 0; i < ticks; i += 1) await new Promise((resolve) => window.setTimeout(resolve, 0));
  };
  await settle();

  return {
    window,
    iframe,
    host,
    events,
    settle,
    document: inner as unknown as Document,
    inView: async (script) =>
      (iframe.contentWindow as unknown as { eval: (source: string) => Promise<unknown> }).eval(script),
    dispose: () => {
      host.dispose();
      dom.window.close();
    },
  };
}

/**
 * What the card actually shows.
 *
 * `#root`, not `body`: the runtime is a `<script>` in the same document, and
 * `body.textContent` includes its source — which contains, among other things,
 * the string this suite uses to detect a render failure. An assertion that
 * matched the script it was testing would pass and fail for the wrong reasons.
 */
function text(frame: Frame): string {
  return frame.document.getElementById("root")?.textContent ?? "";
}

function buttons(frame: Frame): HTMLButtonElement[] {
  return [...frame.document.querySelectorAll("button")] as HTMLButtonElement[];
}

async function deliver(frame: Frame, tool: string, args: Record<string, unknown>, result: CallToolResult): Promise<void> {
  frame.host.deliverHostContext({ displayMode: "inline", theme: "dark", locale: "en-US" });
  frame.host.deliverToolInput(tool, args);
  frame.host.deliverToolResult(result, tool);
  await frame.settle();
}

beforeAll(async () => {
  const context = await createContext({} as NodeJS.ProcessEnv, {
    service: new CaseService(new MemoryCaseRepository()),
  });
  running = await startHttpServer(context, { port: 0 });
  client = new Client({ name: "circa-mcp-apps", version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${running.url}/mcp`)));

  const started = await call("start_repair_case", {
    issueSummary: "A roofer says the chimney flashing has failed",
    trade: "roofing",
    postalCode: "02139",
  });
  caseId = (started.structuredContent as { caseId: string }).caseId;

  await call("capture_offer", {
    caseId,
    description: "They knocked on the door and said the flashing around the chimney has failed",
    companyName: "Apex Exteriors",
    quotedPrice: 6500,
    depositRequested: 3000,
    contractorFoundBy: "DOOR_KNOCK",
    urgencyClaim: "water could get in tonight",
  });
  await call("structure_scope", { caseId });
  await call("find_independent_professionals", { caseId, limit: 3 });
  await call("add_quote", {
    caseId,
    contractorName: "Nine Elms Exterior Surveys",
    source: "SECOND_OPINION",
    text: INDEPENDENT_QUOTE,
  });
  // The refusal, which is the card worth looking hardest at.
  await call("compare_quotes", { caseId });
  await call("add_quote", { caseId, contractorName: "Apex Exteriors", source: "CONTRACTOR", text: ITEMISED_REQUOTE });
  await call("get_repair_dossier", { caseId });
});

afterAll(async () => {
  await client.close().catch(() => undefined);
  await running.close();
});

describe("host to view", () => {
  it("renders a real tool result from ui/notifications/tool-result alone", async () => {
    const result = results.get("compare_quotes")!;
    const frame = await mount(viewUriOf(result));
    try {
      expect(text(frame)).toContain("Waiting for the result");
      await deliver(frame, "compare_quotes", { caseId }, result);
      const rendered = text(frame);
      const payload = result.structuredContent as { refusal: string; quoteA: { total: string }; quoteB: { total: string } };
      expect(rendered).toContain(payload.quoteA.total);
      expect(rendered).toContain(payload.quoteB.total);
      // The product's central claim, on a screen, put there by the protocol.
      expect(rendered).toContain(payload.refusal);
      expect(rendered).toContain("Cannot be said");
    } finally {
      frame.dispose();
    }
  });

  it("never draws the word null, on any of the six views", async () => {
    // `replaceChildren` stringifies whatever it is handed, so a builder that
    // returns null for a section the payload does not have printed "null" on the
    // card. `el()` filtered those children; `mount()` did not, and the result was
    // on screen for most of a three-minute demo. Every view, every recorded
    // result, every text node.
    for (const [tool, result] of results) {
      const uri = (result._meta as { ui?: { resourceUri?: string } } | undefined)?.ui?.resourceUri;
      if (!uri) continue;
      const frame = await mount(uri);
      try {
        await deliver(frame, tool, { caseId }, result);
        const walker = frame.document.createTreeWalker(frame.document.body, 4 /* SHOW_TEXT */);
        const offenders: string[] = [];
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const value = (node.nodeValue ?? "").trim();
          if (value === "null" || value === "undefined" || value === "false" || value === "[object Object]") {
            offenders.push(value);
          }
        }
        expect(offenders, `${tool} -> ${uri}`).toEqual([]);
      } finally {
        frame.dispose();
      }
    }
  });

  it("measures itself after every render, not only the first", async () => {
    const result = results.get("capture_offer")!;
    const frame = await mount(viewUriOf(result));
    const sizeReports = (): number =>
      frame.host.wire().filter((entry) => entry.method === "ui/notifications/size-changed").length;
    try {
      await deliver(frame, "capture_offer", { caseId }, result);
      const afterFirst = sizeReports();
      expect(afterFirst).toBeGreaterThan(0);
      // A card that grows by a row and is never re-measured is a card with its
      // last line cut off on a device nobody tested on.
      frame.host.deliverToolResult(results.get("compare_quotes")!, "compare_quotes");
      await frame.settle();
      expect(sizeReports()).toBeGreaterThan(afterFirst);
      // The measurement itself is jsdom's, and jsdom lays nothing out, so every
      // `scrollHeight` here is 0 and the host drops it. What this asserts is the
      // report, not the pixel — the pixel is the browser's job and the report is
      // the protocol's.
      expect(frame.events.resizes).toEqual([]);
    } finally {
      frame.dispose();
    }
  });

  it("passes the display mode down, and the view lays itself out for it", async () => {
    const result = results.get("get_repair_dossier")!;
    const frame = await mount(viewUriOf(result));
    try {
      await deliver(frame, "get_repair_dossier", { caseId }, result);
      expect(frame.document.body.dataset["displayMode"]).toBe("inline");
      frame.host.deliverHostContext({ displayMode: "fullscreen" });
      await frame.settle();
      expect(frame.document.body.dataset["displayMode"]).toBe("fullscreen");
      // The re-render on a context change is what makes the fullscreen type
      // scale reachable at all; without it the card keeps its inline layout.
      expect(text(frame)).toContain("Nine Elms");
    } finally {
      frame.dispose();
    }
  });

  it("hands the view the whole CallToolResult, not a reduction of it", async () => {
    const result = results.get("compare_quotes")!;
    const frame = await mount(viewUriOf(result));
    try {
      // The runtime reads `params.result.structuredContent`, which only works if
      // the host forwarded the result the model saw.
      await deliver(frame, "compare_quotes", { caseId }, result);
      expect(text(frame)).not.toContain("could not render");
    } finally {
      frame.dispose();
    }
  });
});

describe("view to host", () => {
  it("asks for room before it draws the long form, and gets an answer", async () => {
    const result = results.get("compare_quotes")!;
    const frame = await mount(viewUriOf(result));
    try {
      await deliver(frame, "compare_quotes", { caseId }, result);
      const explain = buttons(frame).find((b) => b.textContent === "Explain the difference");
      expect(explain).toBeDefined();
      explain!.click();
      await frame.settle(10);
      expect(frame.events.displayModes).toEqual(["fullscreen"]);
      // ui/request-display-mode is a request. The view redraws when the answer
      // arrives, so this assertion fails if the host only listened.
      const detail = (result.structuredContent as { detail: string }).detail.split("\n")[0]!;
      expect(text(frame)).toContain(detail);
    } finally {
      frame.dispose();
    }
  });

  it("calls a tool through the host and the host answers with the real result", async () => {
    const result = results.get("capture_offer")!;
    const frame = await mount(viewUriOf(result));
    try {
      await deliver(frame, "capture_offer", { caseId }, result);
      const action = (result.structuredContent as { actions: { label: string; tool: string }[] }).actions[0]!;
      const button = buttons(frame).find((b) => b.textContent === action.label);
      expect(button).toBeDefined();
      const before = results.get(action.tool);
      button!.click();
      await frame.settle(20);
      // The tool really ran, over Streamable HTTP, because of a click in a view.
      expect(results.get(action.tool)).toBeDefined();
      expect(results.get(action.tool)).not.toBe(before);
    } finally {
      frame.dispose();
    }
  });

  it("speaks as the customer with ui/message, so a tap lands in the record", async () => {
    const result = results.get("get_repair_dossier")!;
    const frame = await mount(viewUriOf(result));
    try {
      await deliver(frame, "get_repair_dossier", { caseId }, result);
      const button = buttons(frame).find((b) => b.textContent === "Compare the quotes");
      expect(button, "the dossier card should offer the comparison once there are two quotes").toBeDefined();
      button!.click();
      await frame.settle();
      expect(frame.events.messages).toEqual(["Compare the quotes"]);
    } finally {
      frame.dispose();
    }
  });

  it("tells the model what was chosen on the screen with ui/update-model-context", async () => {
    const result = results.get("find_independent_professionals")!;
    const frame = await mount(viewUriOf(result));
    try {
      await deliver(frame, "find_independent_professionals", { caseId }, result);
      const send = buttons(frame).find((b) => b.textContent === "Send the scope");
      expect(send).toBeDefined();
      send!.click();
      await frame.settle(20);
      expect(frame.events.contexts).toHaveLength(1);
      const first = (result.structuredContent as { matches: { name: string }[] }).matches[0]!;
      // A choice made by tapping is a choice the conversation never heard.
      expect(frame.events.contexts[0]).toContain(first.name);
    } finally {
      frame.dispose();
    }
  });

  it("answers a method it does not implement with an error rather than silence", async () => {
    const result = results.get("get_repair_dossier")!;
    const frame = await mount(viewUriOf(result));
    try {
      await deliver(frame, "get_repair_dossier", { caseId }, result);
      const outcome = await frame.inView(`
        new Promise((resolve) => {
          window.addEventListener("message", function once(event) {
            const message = JSON.parse(event.data);
            if (message.id === "probe") { window.removeEventListener("message", once); resolve(message); }
          });
          window.parent.postMessage(JSON.stringify({ jsonrpc: "2.0", id: "probe", method: "ui/not-a-real-method", params: {} }), "*");
        })
      `);
      expect((outcome as { error?: { code: number } }).error?.code).toBe(-32601);
    } finally {
      frame.dispose();
    }
  });

  it("refuses to open a link, and says so rather than dropping the request", async () => {
    const result = results.get("get_repair_dossier")!;
    const frame = await mount(viewUriOf(result));
    try {
      const outcome = await frame.inView(`
        new Promise((resolve) => {
          window.addEventListener("message", function once(event) {
            const message = JSON.parse(event.data);
            if (message.id === "link") { window.removeEventListener("message", once); resolve(message); }
          });
          window.parent.postMessage(JSON.stringify({ jsonrpc: "2.0", id: "link", method: "ui/open-link", params: { url: "https://example.com" } }), "*");
        })
      `);
      expect((outcome as { error?: { code: number } }).error?.code).toBe(-32001);
      expect(frame.events.links).toEqual(["https://example.com"]);
    } finally {
      frame.dispose();
    }
  });
});

describe("isolation", () => {
  it("ignores a message that did not come from the view it is hosting", async () => {
    // Fabricated events rather than jsdom's, precisely because the workaround
    // above hands jsdom's events the right source. This is the check itself.
    const seen: string[] = [];
    const listeners: ((event: unknown) => void)[] = [];
    const fakeWindow = {
      addEventListener: (_type: string, listener: (event: unknown) => void) => listeners.push(listener),
      removeEventListener: () => undefined,
    } as unknown as Window;
    const theView = { postMessage: () => undefined };
    const somebodyElse = { postMessage: () => undefined };
    const host = new ViewHost(
      {
        callTool: async () => ({}),
        requestDisplayMode: (mode) => mode,
        message: (t) => seen.push(t),
        updateModelContext: (t) => seen.push(t),
        openLink: () => false,
        resize: () => undefined,
      },
      fakeWindow,
    );
    host.setFrame({ contentWindow: theView } as unknown as HTMLIFrameElement);

    const payload = JSON.stringify({ jsonrpc: "2.0", method: "ui/message", params: { text: "from somewhere else" } });
    for (const listener of listeners) listener({ source: somebodyElse, data: payload });
    expect(seen).toEqual([]);

    for (const listener of listeners) listener({ source: theView, data: payload });
    expect(seen).toEqual(["from somewhere else"]);
    host.dispose();
  });
});

describe("the wire", () => {
  it("carries every message name SEP-1865 defines for this pair", async () => {
    const result = results.get("compare_quotes")!;
    const frame = await mount(viewUriOf(result));
    try {
      await deliver(frame, "compare_quotes", { caseId }, result);
      buttons(frame).find((b) => b.textContent === "Explain the difference")!.click();
      await frame.settle(10);
      const methods = new Set(frame.host.wire().map((entry: WireEntry) => entry.method));
      for (const expected of [
        "ui/notifications/host-context-changed",
        "ui/notifications/tool-input",
        "ui/notifications/tool-result",
        "ui/notifications/size-changed",
        "ui/request-display-mode",
      ]) {
        expect(methods, `${expected} never crossed`).toContain(expected);
      }
    } finally {
      frame.dispose();
    }
  });
});
