/**
 * The host half of MCP Apps (SEP-1865).
 *
 * `apps/mcp-server/src/ui/runtime.ts` is the other half and it is inlined into
 * every view. The two were written against the spec rather than against each
 * other, and `tests/mcp-apps.test.ts` drives this file against that one over the
 * documented message names, so a rename on either side is a failing test rather
 * than a card that silently stops updating.
 *
 * Three things a host owes a view, and this one pays all three:
 *
 * **Isolation.** The iframe is `sandbox="allow-scripts"` and nothing else. That
 * gives it an opaque origin, which means `event.origin` is the string `"null"`
 * and origin checking is useless — so the check is `event.source ===
 * iframe.contentWindow`, which is the identity that actually holds. A view
 * rendering a contractor's document is the last place to be lax about this.
 *
 * **Sizing.** The view measures itself and says how tall it is. A host that
 * ignores `ui/notifications/size-changed` gets a card with its last line cut off
 * on whichever device nobody tested on.
 *
 * **Answers.** `tools/call`, `ui/request-display-mode` and `ui/open-link` are
 * requests, not notifications: the view is waiting on a JSON-RPC result, and a
 * host that only listens leaves a button spinning forever.
 */

export type DisplayMode = "inline" | "fullscreen" | "pip";

export interface HostEvents {
  /** The view asked to run a tool. The host runs it and the result comes back to the view. */
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  /** `ui/request-display-mode`. The host decides; returning a different mode is allowed by the spec. */
  requestDisplayMode: (mode: DisplayMode) => DisplayMode;
  /** `ui/message` — the view speaking as the user. */
  message: (text: string) => void;
  /** `ui/update-model-context` — the view telling the model something without saying it out loud. */
  updateModelContext: (text: string) => void;
  /** `ui/open-link`. Refusing is a valid answer and this host refuses. */
  openLink: (url: string) => boolean;
  /** `ui/notifications/size-changed`. */
  resize: (height: number) => void;
  /** Anything the host does not implement, recorded rather than dropped, so the wire log stays complete. */
  unhandled?: (method: string, params: unknown) => void;
}

export interface WireEntry {
  direction: "host→view" | "view→host";
  method: string;
  at: number;
  detail?: string;
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

export class ViewHost {
  private frame: HTMLIFrameElement | undefined;
  private readonly log: WireEntry[] = [];
  private onLog: ((entries: readonly WireEntry[]) => void) | undefined;

  /**
   * `view` is the window the host listens on, and it is a parameter rather than
   * the global because a host that can only be constructed against
   * `globalThis.window` is a host that can only be tested by loading a browser.
   * `tests/mcp-apps.test.ts` passes a document window and drives the real view
   * runtime against this file.
   */
  constructor(
    private readonly events: HostEvents,
    private readonly view: Window = globalThis.window,
  ) {
    this.attach();
  }

  /**
   * Idempotent on purpose.
   *
   * React's StrictMode mounts an effect, tears it down and mounts it again, and
   * a host that only ever listens from its constructor comes back from that
   * cycle deaf: the teardown removed the listener and the second mount, holding
   * the same memoised instance, added nothing. The card kept rendering and every
   * button on it stopped working — visible only by pressing one.
   */
  attach(): void {
    this.view.removeEventListener("message", this.receive as EventListener);
    this.view.addEventListener("message", this.receive as EventListener);
  }

  detach(): void {
    this.view.removeEventListener("message", this.receive as EventListener);
  }

  /** @deprecated Use {@link detach}. Kept because "dispose" is what a caller reaches for. */
  dispose(): void {
    this.detach();
  }

  /** Every message either way, in order. This is what makes the protocol visible in the video. */
  wire(): readonly WireEntry[] {
    return this.log;
  }

  onWire(listener: (entries: readonly WireEntry[]) => void): void {
    this.onLog = listener;
  }

  private record(entry: WireEntry): void {
    this.log.push(entry);
    if (this.log.length > 400) this.log.splice(0, 100);
    this.onLog?.(this.log);
  }

  setFrame(frame: HTMLIFrameElement | undefined): void {
    this.frame = frame;
  }

  private post(message: JsonRpcMessage): void {
    const target = this.frame?.contentWindow;
    if (!target) return;
    target.postMessage(JSON.stringify({ jsonrpc: "2.0", ...message }), "*");
  }

  private notify(method: string, params: Record<string, unknown>, detail?: string): void {
    this.record({ direction: "host→view", method, at: Date.now(), ...(detail ? { detail } : {}) });
    this.post({ method, params });
  }

  /**
   * `ui/notifications/tool-result`, carrying the whole `CallToolResult`.
   *
   * The whole thing, not the structured content: SEP-1865 hands the view the
   * result the model saw, and a host that forwarded a subset would let a view
   * render something the conversation does not contain.
   */
  deliverToolResult(result: unknown, toolName: string): void {
    this.notify("ui/notifications/tool-result", { result: result as Record<string, unknown> }, toolName);
  }

  /** `ui/notifications/tool-input` — the arguments, before the result exists. */
  deliverToolInput(toolName: string, args: Record<string, unknown>): void {
    this.notify("ui/notifications/tool-input", { toolName, arguments: args }, toolName);
  }

  /** `ui/notifications/host-context-changed` — display mode, theme, locale. */
  deliverHostContext(context: { displayMode: DisplayMode; theme?: string; locale?: string }): void {
    this.notify("ui/notifications/host-context-changed", { ...context }, context.displayMode);
  }

  private receive = (event: MessageEvent): void => {
    // A sandboxed iframe has an opaque origin, so `event.origin` is "null" and
    // proves nothing. The window identity is the check that holds.
    if (!this.frame || event.source !== this.frame.contentWindow) return;
    let message: JsonRpcMessage;
    try {
      message = typeof event.data === "string" ? (JSON.parse(event.data) as JsonRpcMessage) : (event.data as JsonRpcMessage);
    } catch {
      return;
    }
    if (!message || message.jsonrpc !== "2.0" || !message.method) return;
    void this.handle(message);
  };

  private respond(id: string | number, result: unknown): void {
    this.post({ id, result });
  }

  private fail(id: string | number, code: number, message: string): void {
    this.post({ id, error: { code, message } });
  }

  private async handle(message: JsonRpcMessage): Promise<void> {
    const { method, params = {}, id } = message;
    this.record({ direction: "view→host", method: method!, at: Date.now(), ...(describe(method!, params) ? { detail: describe(method!, params)! } : {}) });

    switch (method) {
      case "ui/notifications/size-changed": {
        const height = Number(params["height"] ?? 0);
        if (Number.isFinite(height) && height > 0) this.events.resize(height);
        return;
      }
      case "ui/message": {
        this.events.message(String(params["text"] ?? ""));
        return;
      }
      case "ui/update-model-context": {
        this.events.updateModelContext(String(params["text"] ?? ""));
        return;
      }
      case "ui/notifications/request-teardown": {
        this.setFrame(undefined);
        return;
      }
      case "ui/request-display-mode": {
        const asked = String(params["mode"] ?? "inline") as DisplayMode;
        const granted = this.events.requestDisplayMode(asked);
        // The spec lets a host grant something other than what was asked for, so
        // the granted mode is echoed back rather than assumed by the view.
        if (id !== undefined) this.respond(id, { mode: granted });
        this.deliverHostContext({ displayMode: granted });
        return;
      }
      case "ui/open-link": {
        const url = String(params["url"] ?? "");
        const allowed = this.events.openLink(url);
        if (id !== undefined) {
          if (allowed) this.respond(id, {});
          // A refusal is an error the view can render, not silence.
          else this.fail(id, -32001, "This host does not open links from a view.");
        }
        return;
      }
      case "tools/call": {
        const name = String(params["name"] ?? "");
        const args = (params["arguments"] ?? {}) as Record<string, unknown>;
        if (id === undefined) return;
        try {
          const result = await this.events.callTool(name, args);
          this.respond(id, result);
        } catch (error) {
          this.fail(id, -32603, error instanceof Error ? error.message : String(error));
        }
        return;
      }
      default: {
        this.events.unhandled?.(method!, params);
        if (id !== undefined) this.fail(id, -32601, `This host does not implement ${method}`);
      }
    }
  }
}

function describe(method: string, params: Record<string, unknown>): string | undefined {
  if (method === "tools/call") return String(params["name"] ?? "");
  if (method === "ui/request-display-mode") return String(params["mode"] ?? "");
  if (method === "ui/notifications/size-changed") return `${params["height"]}px`;
  if (method === "ui/message" || method === "ui/update-model-context") return String(params["text"] ?? "").slice(0, 48);
  if (method === "ui/open-link") return String(params["url"] ?? "");
  return undefined;
}
