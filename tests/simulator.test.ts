import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { act } from "react-dom/test-utils";
import { CaseService, MemoryCaseRepository } from "#store";
import { createContext } from "../apps/mcp-server/src/context.js";
import { startHttpServer, type RunningServer } from "../apps/mcp-server/src/http.js";
import { REQUIRED_PROTOCOL_VERSION } from "../apps/mcp-server/src/server.js";
import { SCRIPT } from "../tools/demo/src/script.js";

/**
 * The simulator, mounted and driven.
 *
 * Not the components in isolation — the page. `App.tsx` is rendered into a
 * document with React's own client renderer, it connects to a real CIRCA server
 * over Streamable HTTP with the SDK's own client, and the buttons are pressed
 * the way a person presses them.
 *
 * The reason this file exists rather than a screenshot: a suite that only tests
 * the API can be entirely green while the page that judges will actually watch
 * is blank, and finding that out during a recording is a bad afternoon. Every
 * assertion below is on rendered text, which is the only thing a viewer sees.
 *
 * What it cannot cover is the card itself: jsdom does not implement `srcdoc`, so
 * the iframe stays empty here. The view's own rendering is covered by
 * `tests/mcp-apps.test.ts`, which installs the same markup a different way. So
 * this file asserts that the page fetched the view over MCP and handed it to the
 * device, and stops there.
 */

let running: RunningServer;
let dom: JSDOM;
let root: HTMLElement;

/**
 * Let time pass inside `act`.
 *
 * React batches, and a promise that resolves outside `act` leaves the tree
 * un-rendered — so waiting with a bare `setTimeout` watches a page that has
 * stopped updating and reports the last frame forever.
 */
const settle = async (ms = 60): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
};

/** Wait for a predicate on the rendered page, so a slow round trip is not a flake. */
async function until(what: string, predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await settle(40);
  }
  throw new Error(`timed out waiting for ${what}. Page said:\n${root.textContent?.slice(-900)}`);
}

const pageText = (): string => root.textContent ?? "";

function buttonSaying(fragment: string): HTMLButtonElement {
  const found = [...root.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(fragment));
  if (!found) throw new Error(`no button containing "${fragment}". Buttons: ${[...root.querySelectorAll("button")].map((b) => b.textContent).join(" | ")}`);
  return found as HTMLButtonElement;
}

async function click(fragment: string): Promise<void> {
  const button = buttonSaying(fragment);
  await act(async () => {
    button.click();
  });
  await settle(20);
}

/** Put a sentence in the box. The box is uncontrolled, so this is what typing is. */
async function type(text: string): Promise<void> {
  const input = root.querySelector("input") as HTMLInputElement | null;
  if (!input) throw new Error("the page has no input box");
  input.value = text;
  await settle(5);
}

beforeAll(async () => {
  const context = await createContext({} as NodeJS.ProcessEnv, {
    service: new CaseService(new MemoryCaseRepository()),
  });
  running = await startHttpServer(context, { port: 0 });

  // The page reads `window.location.origin` to build the MCP endpoint, so the
  // document is given the server's own origin. Nothing is stubbed: the transport
  // is Node's fetch against a bound port.
  dom = new JSDOM(`<!doctype html><html><body><div id="root"></div></body></html>`, {
    url: running.url,
    pretendToBeVisual: true,
  });
  // React reads these off the global scope. `navigator` is a getter-only
  // property on Node's globalThis, so it is defined rather than assigned.
  const globals = globalThis as unknown as Record<string, unknown>;
  for (const name of ["window", "document", "HTMLElement", "HTMLIFrameElement", "Element", "Node", "Event", "MessageEvent"]) {
    globals[name] = (dom.window as unknown as Record<string, unknown>)[name === "window" ? "window" : name];
  }
  globals["window"] = dom.window;
  globals["document"] = dom.window.document;
  Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
  globals["IS_REACT_ACT_ENVIRONMENT"] = true;
  // jsdom implements no scrolling at all, and the transcript keeps itself
  // pinned to the newest turn. Without this the page throws in an effect, React
  // unmounts the whole tree, and the failure reads as "never connected".
  dom.window.Element.prototype.scrollTo = function scrollTo(): void {
    /* jsdom has no layout */
  };

  const { createRoot } = await import("react-dom/client");
  const { createElement } = await import("react");
  const { App } = await import("../apps/simulator/src/App.js");

  root = dom.window.document.getElementById("root")!;
  await act(async () => {
    createRoot(root).render(createElement(App));
  });
  await settle();
});

afterAll(async () => {
  await running.close();
  dom.window.close();
});

describe("the page", () => {
  it("connects and prints the protocol version the two sides negotiated", async () => {
    await until("the status bar", () => pageText().includes("Play the demo"));
    // Not a constant this page chose: `transport.protocolVersion` after a real
    // initialize. If the SDK's default moved, this line would move with it.
    expect(pageText()).toContain(REQUIRED_PROTOCOL_VERSION);
    expect(pageText()).toContain("16");
    expect(pageText()).toContain("Play the demo");
  });

  it("plays the scripted arc, one beat at a time, over real tool calls", async () => {
    await click("Next beat");
    await until("the first beat", () => pageText().includes("I have opened a record"));
    expect(pageText()).toContain("start_repair_case");
    // The transcript is the tool result's own `content`. If the page wrote its
    // own sentences here, voice-only would not be the same product.
    expect(pageText()).toContain(SCRIPT[0]!.said);

    await click("Next beat");
    await until("the offer", () => pageText().includes("capture_offer"));
    expect(pageText()).toMatch(/cannot|can't/i);
  });

  it("shows the refusal in the transcript when the gap cannot be attributed", async () => {
    for (let i = 0; i < 6; i += 1) {
      await click("Next beat");
      await settle(120);
    }
    await until("the comparison", () => pageText().includes("compare_quotes"), 15_000);
    // The product's central claim, on the page a judge will watch.
    expect(pageText()).toMatch(/itemised/i);
  });

  it("fetched the card over MCP and handed it to the device", async () => {
    const frame = root.querySelector("iframe");
    expect(frame, "the device should be showing a view").not.toBeNull();
    const markup = frame!.getAttribute("srcdoc") ?? "";
    // Served by `resources/read` as text/html;profile=mcp-app — this page ships
    // no card markup of its own, which is why the assertion is on the srcdoc.
    expect(markup).toContain("<!doctype html>");
    expect(markup).toContain("ui/notifications/tool-result");
    expect(pageText()).toContain("ui://circa/");
  });

  it("plans an unscripted utterance with the deterministic planner", async () => {
    await type("What have you found?");
    await click("Say it");
    await until("the planned status call", () => pageText().includes("get_verification_status"), 10_000);
    expect(pageText()).toContain("What have you found?");
  });

  it("says it did not follow rather than reaching for an adjacent tool", async () => {
    await type("what is the weather like in Boston");
    await click("Say it");
    await until("the clarification", () => pageText().includes("I did not follow that"), 8000);
  });
});
