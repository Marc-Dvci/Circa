import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { plan, type PlannerState } from "../../agent/src/planner.js";
import { SCRIPT, type Beat } from "../../../tools/demo/src/script.js";
import { viewUriOf } from "./mcp.js";

/**
 * The conversation.
 *
 * This is the part of a host that decides what to call, and it is deliberately
 * the *deterministic* planner from `apps/agent/src/planner.ts` rather than
 * anything this file invented. Alexa+ puts a model here; the model is the one
 * piece a hackathon judge cannot run without an account, so the simulator drives
 * the same planner that `pnpm circa say` drives and that the corpus scores. What
 * the simulator adds is the host: the transport, the views, and the wire.
 *
 * Everything spoken comes from the tool result's own `content`. The simulator
 * writes no sentences about a repair, which is why it can be trusted as evidence
 * that voice-only is complete: if a card shows something the transcript does not
 * say, the payload was wrong, not the screen.
 */

export type TurnRole = "user" | "circa" | "caption" | "error" | "note";

export interface Turn {
  id: number;
  role: TurnRole;
  text: string;
  tool?: string;
  ms?: number;
  viewUri?: string;
  refusal?: string;
  note?: string;
  /** The full CallToolResult, handed to the view untouched. */
  result?: unknown;
  args?: Record<string, unknown>;
}

export interface SessionState {
  turns: Turn[];
  busy: boolean;
  caseId?: string;
  /** Where the script has got to. Undefined once it has finished. */
  scriptIndex: number;
  modelContext: string[];
}

type Listener = (state: SessionState) => void;

function substitute(value: unknown, bindings: Record<string, string>): unknown {
  if (typeof value === "string" && value.startsWith("$")) {
    const bound = bindings[value.slice(1)];
    if (bound === undefined) throw new Error(`the script referred to ${value} before anything set it`);
    return bound;
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, bindings));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, bindings)]));
  }
  return value;
}

export class Session {
  private nextId = 1;
  private readonly listeners = new Set<Listener>();
  private readonly bindings: Record<string, string> = {};
  private state: SessionState = { turns: [], busy: false, scriptIndex: 0, modelContext: [] };

  /** Planner state, kept from what the tools returned rather than from what was asked. */
  private planner: PlannerState = { hasOffer: false, quoteCount: 0, hasBaseline: false };

  constructor(private readonly client: Client) {}

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  private emit(patch: Partial<SessionState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }

  private push(turn: Omit<Turn, "id">): Turn {
    const full: Turn = { id: this.nextId++, ...turn };
    this.emit({ turns: [...this.state.turns, full] });
    return full;
  }

  get scriptLength(): number {
    return SCRIPT.length;
  }

  nextBeat(): Beat | undefined {
    return SCRIPT[this.state.scriptIndex];
  }

  /** Something the view told the model without saying it aloud. */
  noteModelContext(text: string): void {
    this.emit({ modelContext: [...this.state.modelContext, text] });
  }

  say(text: string): void {
    this.push({ role: "user", text });
  }

  /**
   * Call one tool and turn the result into a turn.
   *
   * `speech` is not read from `structuredContent`. It is read from the result's
   * `content`, which is what a host without any knowledge of CIRCA would have,
   * and it is the same string either way — that equality is the whole voice-only
   * claim and it should be checked by using the weaker of the two.
   */
  async callTool(name: string, args: Record<string, unknown>, note?: string): Promise<Turn> {
    this.emit({ busy: true });
    const started = performance.now();
    try {
      const result = await this.client.callTool({ name, arguments: args });
      const ms = performance.now() - started;
      const spoken = ((result.content ?? []) as { type: string; text?: string }[])
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join(" ");

      if (result.isError) {
        return this.push({ role: "error", text: spoken || `${name} failed`, tool: name, ms, args });
      }

      const payload = (result.structuredContent ?? {}) as Record<string, unknown>;
      this.absorb(name, args, payload);

      return this.push({
        role: "circa",
        text: spoken,
        tool: name,
        ms,
        args,
        result,
        ...(viewUriOf(result) ? { viewUri: viewUriOf(result)! } : {}),
        ...(typeof payload["refusal"] === "string" ? { refusal: payload["refusal"] } : {}),
        ...(note ? { note } : {}),
      });
    } catch (error) {
      return this.push({
        role: "error",
        text: error instanceof Error ? error.message : String(error),
        tool: name,
        ms: performance.now() - started,
        args,
      });
    } finally {
      this.emit({ busy: false });
    }
  }

  /** Learn the ids and the state from what came back, never from what was sent. */
  private absorb(tool: string, args: Record<string, unknown>, payload: Record<string, unknown>): void {
    if (typeof payload["caseId"] === "string" && !this.bindings["caseId"]) {
      this.bindings["caseId"] = payload["caseId"];
      this.planner = { ...this.planner, caseId: payload["caseId"] };
      this.emit({ caseId: payload["caseId"] });
    }
    if (tool === "capture_offer") this.planner = { ...this.planner, hasOffer: true };
    if (tool === "find_independent_professionals") {
      const matches = payload["matches"] as { id: string }[] | undefined;
      if (matches?.[0]) {
        this.bindings["providerId"] = matches[0].id;
        this.planner = { ...this.planner, lastProviderId: matches[0].id };
      }
    }
    if (tool === "add_quote" && typeof payload["quoteId"] === "string") {
      const key = (args["source"] as string) === "CONTRACTOR" ? "quoteApex" : "quoteB";
      this.bindings[key] = payload["quoteId"];
      this.planner = {
        ...this.planner,
        quoteCount: this.planner.quoteCount + 1,
        lastQuoteId: payload["quoteId"],
      };
    }
    if (tool === "record_scope_change" && typeof payload["changeId"] === "string") {
      this.bindings["changeId"] = payload["changeId"];
    }
    if (tool === "accept_scope") this.planner = { ...this.planner, hasBaseline: true };
    if (tool === "delete_repair_case") this.planner = { hasOffer: false, quoteCount: 0, hasBaseline: false };
  }

  /** One utterance, planned deterministically and executed. */
  async utter(text: string): Promise<void> {
    this.say(text);
    const planned = plan(text, this.planner);
    if (planned.calls.length === 0) {
      // A planner that has not understood says so. Reaching for an adjacent tool
      // is how an agent loses a person's trust in a single turn.
      this.push({ role: "circa", text: planned.clarification ?? "I did not follow that." });
      return;
    }
    for (const call of planned.calls) {
      await this.callTool(call.tool, call.arguments, `planner: ${call.matched}`);
    }
  }

  /** Advance the scripted arc by one beat. */
  async playNext(): Promise<boolean> {
    const beat = SCRIPT[this.state.scriptIndex];
    if (!beat) return false;
    this.emit({ scriptIndex: this.state.scriptIndex + 1 });
    if (beat.caption) this.push({ role: "caption", text: beat.caption });
    if (beat.said) this.say(beat.said);
    const args = substitute(beat.arguments, this.bindings) as Record<string, unknown>;
    await this.callTool(beat.tool, args, beat.note);
    return this.state.scriptIndex < SCRIPT.length;
  }

  async playAll(pauseMs = 1200): Promise<void> {
    while (await this.playNext()) {
      await new Promise((resolve) => setTimeout(resolve, pauseMs));
    }
  }

  reset(): void {
    for (const key of Object.keys(this.bindings)) delete this.bindings[key];
    this.planner = { hasOffer: false, quoteCount: 0, hasBaseline: false };
    this.state = { turns: [], busy: false, scriptIndex: 0, modelContext: [] };
    for (const listener of this.listeners) listener(this.state);
  }
}
