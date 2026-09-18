import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { connect, readView, type Connection } from "./mcp.js";
import { Session, type SessionState, type Turn } from "./session.js";
import { ViewHost, type DisplayMode, type WireEntry } from "./host.js";
import { Tour } from "./Tour.js";

/** `?tour=1` plays the guided tour used for the demo video. Read lazily: the test suite imports this module under jsdom without a location. */
const touring = (): boolean => typeof location !== "undefined" && new URLSearchParams(location.search).has("tour");

/**
 * The page.
 *
 * Two panes and a status bar, and every number in the status bar came off the
 * connection. The left pane is the conversation as a voice-only device would
 * have it — the exact strings in each tool result's `content`. The right pane is
 * the Echo Show card, which is an MCP Apps view served as a resource over the
 * same connection and rendered in a sandboxed iframe this page cannot see into.
 *
 * Reading them side by side is the point. Everything the card shows, the
 * transcript already said.
 */

export function App(): JSX.Element {
  const [connection, setConnection] = useState<Connection | undefined>();
  const [failure, setFailure] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    connect()
      .then((value) => {
        if (!cancelled) setConnection(value);
      })
      .catch((error: unknown) => {
        if (!cancelled) setFailure(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (failure) {
    return (
      <div className="boot">
        <h1>CIRCA is not answering</h1>
        <p>{failure}</p>
        <p className="dim">
          The simulator talks to the MCP server over Streamable HTTP at <code>/mcp</code>. Start it with{" "}
          <code>pnpm mcp</code>, or let <code>pnpm simulator:dev</code> start it for you.
        </p>
      </div>
    );
  }

  if (!connection) {
    return (
      <div className="boot">
        <h1>Connecting</h1>
        <p className="dim">initialize · Streamable HTTP · /mcp</p>
      </div>
    );
  }

  return <Console connection={connection} />;
}

function Console({ connection }: { connection: Connection }): JSX.Element {
  const session = useMemo(() => new Session(connection.client), [connection]);
  const [state, setState] = useState<SessionState>({ turns: [], busy: false, scriptIndex: 0, modelContext: [] });
  const [displayMode, setDisplayMode] = useState<DisplayMode>("inline");
  const [wire, setWire] = useState<readonly WireEntry[]>([]);
  const [showWire, setShowWire] = useState(false);
  // Uncontrolled: the box holds one sentence, it is read once on submit and
  // cleared. A controlled value would re-render the whole console on every
  // keystroke to hold a string nothing else reads.
  const utteranceRef = useRef<HTMLInputElement>(null);

  useEffect(() => session.subscribe(setState), [session]);

  const transcriptRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: "smooth" });
  }, [state.turns.length]);

  const latest = useMemo(() => [...state.turns].reverse().find((t) => t.viewUri && t.result), [state.turns]);

  const play = useCallback(() => void session.playAll(), [session]);
  const step = useCallback(() => void session.playNext(), [session]);
  const submit = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      const box = utteranceRef.current;
      const text = box?.value.trim() ?? "";
      if (!text || state.busy) return;
      if (box) box.value = "";
      void session.utter(text);
    },
    [session, state.busy],
  );

  const nextBeat = session.nextBeat();
  const tourControls = useMemo(() => ({ playNext: () => session.playNext() }), [session]);
  const TOURING = touring();

  return (
    <div className={`app mode-${displayMode}${TOURING ? " touring" : ""}`}>
      {TOURING ? <Tour controls={tourControls} /> : null}
      <div className="stage">
        <header>
          <div className="brand">
            <span className="dot" /> Alexa+ <span className="dim">simulator</span>
          </div>
          <div className="facts">
            <Fact label="server" value={connection.serverName} />
            <Fact label="transport" value="Streamable HTTP" />
            <Fact label="protocol" value={connection.protocolVersion} strong />
            <Fact label="session" value={connection.sessionId?.slice(0, 8) ?? "none"} />
            <Fact label="tools" value={String(connection.toolCount)} />
            <Fact label="views" value={String(connection.viewCount)} />
          </div>
        </header>

        <main>
          <section className="transcript" ref={transcriptRef}>
            <div className="transcript-inner">
              {state.turns.length === 0 ? (
                <p className="empty">
                  Press <strong>Play the demo</strong>, or say something. The planner is deterministic and needs no
                  model — try <em>“a roofer knocked on the door and says the flashing has failed”</em>.
                </p>
              ) : null}
              {state.turns.map((turn) => (
                <TurnLine key={turn.id} turn={turn} />
              ))}
              {state.busy ? <div className="turn thinking">…</div> : null}
            </div>
          </section>

          <section className="device-pane">
            <Device
              client={connection.client}
              session={session}
              turn={latest}
              displayMode={displayMode}
              onDisplayMode={setDisplayMode}
              onWire={setWire}
            />
            <div className="under-device">
              <button className="link" onClick={() => setShowWire((v) => !v)}>
                {showWire ? "hide" : "show"} the MCP Apps wire ({wire.length})
              </button>
              {state.modelContext.length > 0 ? (
                <span className="dim"> · {state.modelContext.length} context updates from the card</span>
              ) : null}
            </div>
            {showWire ? <Wire entries={wire} /> : null}
          </section>
        </main>

        <footer>
          <form onSubmit={submit}>
            <input
              ref={utteranceRef}
              placeholder="Say something to Alexa…"
              disabled={state.busy}
              aria-label="What you say to Alexa"
            />
            <button type="submit" disabled={state.busy}>
              Say it
            </button>
          </form>
          <div className="controls">
            {nextBeat ? (
              <button className="secondary" onClick={step} disabled={state.busy}>
                Next beat <span className="dim">({state.scriptIndex + 1}/{session.scriptLength})</span>
              </button>
            ) : null}
            <button onClick={play} disabled={state.busy || !nextBeat}>
              Play the demo
            </button>
            <button
              className="secondary"
              onClick={() => {
                session.reset();
                setDisplayMode("inline");
              }}
              disabled={state.busy}
            >
              Reset
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

function Fact({ label, value, strong }: { label: string; value: string; strong?: boolean }): JSX.Element {
  return (
    <span className={`fact${strong ? " strong" : ""}`}>
      <span className="dim">{label}</span> {value}
    </span>
  );
}

function TurnLine({ turn }: { turn: Turn }): JSX.Element {
  if (turn.role === "caption") return <div className="caption">{turn.text}</div>;
  return (
    <div className={`turn ${turn.role}`}>
      <div className="who">{turn.role === "user" ? "You" : turn.role === "error" ? "!" : "CIRCA"}</div>
      <div className="what">
        <p>{turn.text}</p>
        {turn.refusal ? <p className="refusal">{turn.refusal}</p> : null}
        {turn.tool ? (
          <p className="meta">
            {turn.tool}
            {turn.ms !== undefined ? ` · ${turn.ms.toFixed(0)} ms` : ""}
            {turn.viewUri ? ` · ${turn.viewUri}` : ""}
          </p>
        ) : null}
        {turn.note ? <p className="note">{turn.note}</p> : null}
      </div>
    </div>
  );
}

/**
 * The Echo Show, and the host half of MCP Apps.
 *
 * The iframe is `sandbox="allow-scripts"`, so the view has an opaque origin and
 * this page cannot read into it and it cannot read out. Everything crosses as
 * `postMessage` under the names SEP-1865 defines, which is why the wire panel is
 * worth showing at all: those names are the contract, and here they are moving.
 */
function Device({
  client,
  session,
  turn,
  displayMode,
  onDisplayMode,
  onWire,
}: {
  client: Client;
  session: Session;
  turn: Turn | undefined;
  displayMode: DisplayMode;
  onDisplayMode: (mode: DisplayMode) => void;
  onWire: (entries: readonly WireEntry[]) => void;
}): JSX.Element {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [html, setHtml] = useState<string>("");
  const [height, setHeight] = useState(220);
  const [error, setError] = useState<string | undefined>();
  const pending = useRef<Turn | undefined>(undefined);
  const currentUri = useRef<string | undefined>(undefined);

  const host = useMemo(
    () =>
      new ViewHost({
        callTool: async (name, args) => {
          const result = await session.callTool(name, args, "from the card");
          return result.result ?? { content: [{ type: "text", text: result.text }] };
        },
        requestDisplayMode: (mode) => {
          // This host grants inline and fullscreen, and answers "pip" with
          // inline. Saying yes to a mode the page cannot actually produce is
          // how a card ends up drawn at a size no device has.
          const granted: DisplayMode = mode === "pip" ? "inline" : mode;
          onDisplayMode(granted);
          return granted;
        },
        message: (text) => void session.utter(text),
        updateModelContext: (text) => session.noteModelContext(text),
        openLink: () => false,
        resize: (value) => setHeight(Math.min(760, Math.max(140, value + 2))),
      }),
    [session, onDisplayMode],
  );

  useEffect(() => {
    host.attach();
    host.onWire((entries) => onWire([...entries]));
    return () => host.detach();
  }, [host, onWire]);

  const deliver = useCallback(
    (target: Turn) => {
      host.deliverHostContext({ displayMode, theme: "dark", locale: "en-US" });
      if (target.tool && target.args) host.deliverToolInput(target.tool, target.args);
      if (target.result) host.deliverToolResult(target.result, target.tool ?? "");
    },
    [host, displayMode],
  );

  useEffect(() => {
    if (!turn?.viewUri) return;
    let cancelled = false;
    readView(client, turn.viewUri)
      .then((markup) => {
        if (cancelled) return;
        setError(undefined);
        if (currentUri.current === turn.viewUri) {
          // Same view, new result. A host does not reload a card to update it.
          deliver(turn);
          return;
        }
        currentUri.current = turn.viewUri;
        pending.current = turn;
        setHtml(markup);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [client, turn, deliver]);

  useEffect(() => {
    host.setFrame(frameRef.current ?? undefined);
  }, [host, html]);

  useEffect(() => {
    host.deliverHostContext({ displayMode, theme: "dark", locale: "en-US" });
  }, [host, displayMode]);

  return (
    <div className={`device ${displayMode}`}>
      <div className="bezel">
        <div className="screen" style={{ height }}>
          {error ? <p className="boot-error">{error}</p> : null}
          {html ? (
            <iframe
              key={currentUri.current}
              ref={frameRef}
              title="CIRCA card"
              sandbox="allow-scripts"
              srcDoc={html}
              onLoad={() => {
                host.setFrame(frameRef.current ?? undefined);
                if (pending.current) {
                  deliver(pending.current);
                  pending.current = undefined;
                }
              }}
            />
          ) : (
            <p className="idle">Echo Show · nothing to display yet</p>
          )}
        </div>
      </div>
      <div className="device-label">
        {currentUri.current ? (
          <>
            <code>{currentUri.current}</code> · {displayMode}
          </>
        ) : (
          <span className="dim">the card is a resource on the MCP connection, not a file this page ships</span>
        )}
      </div>
    </div>
  );
}

function Wire({ entries }: { entries: readonly WireEntry[] }): JSX.Element {
  return (
    <div className="wire">
      {entries.length === 0 ? <p className="dim">nothing yet</p> : null}
      {entries.slice(-40).map((entry, index) => (
        <div key={`${entry.at}-${index}`} className={entry.direction === "host→view" ? "out" : "in"}>
          <span className="arrow">{entry.direction === "host→view" ? "→" : "←"}</span>
          <code>{entry.method}</code>
          {entry.detail ? <span className="dim"> {entry.detail}</span> : null}
        </div>
      ))}
    </div>
  );
}
