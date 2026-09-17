/**
 * The guided tour: `http://localhost:5173/?tour=1`.
 *
 * It is a demonstration, not a mock. Every beat below either narrates what is
 * already on screen or advances the same scripted arc `pnpm demo` runs, through
 * the same session, over the same Streamable HTTP connection, into the same
 * sandboxed card. Nothing on screen is drawn by the tour except its own caption
 * bar, the title cards, and the ring around whatever it is pointing at.
 *
 * Pacing. Each beat has a default duration, and the recorder overrides all of
 * them at once by setting `window.__CIRCA_TIMING` to an array of milliseconds
 * measured from the narration audio (`demo_video/narrate.py`). The beat runs its
 * action, then holds the remainder, so a fast machine and a slow one draw the
 * same frames under the same words.
 */
import { useCallback, useEffect, useRef, useState } from "react";

export interface TourControls {
  /** Advance the scripted arc by one beat; resolves when the tool result is on screen. */
  playNext: () => Promise<boolean>;
}

interface Beat {
  /** Shown on screen and in the subtitles. Read aloud as written unless `spoken` says otherwise. */
  caption: string;
  /** What the narrator says when the caption is not how it is pronounced. Same words otherwise. */
  spoken?: string;
  ms: number;
  /** A CSS selector to ring, once the beat's action has settled. */
  focus?: string;
  /** A full-bleed title card instead of the product. */
  card?: { title: string; lines: string[] };
  /** How many scripted beats this narration beat plays. */
  play?: number;
}

const LAST_TURN = ".transcript-inner > .turn:last-of-type";
const CARD = ".bezel";

const BEATS: Beat[] = [
  {
    caption: "CIRCA is an Alexa+ add-on that checks what can be checked before you pay a contractor.",
    spoken: "CIRCA is an Alexa plus add-on that checks what can be checked before you pay a contractor.",
    ms: 7000,
    card: { title: "CIRCA", lines: ["A second opinion before you say yes.", "An Alexa+ add-on, and an MCP server."] },
  },
  {
    caption:
      "The status bar shows the MCP protocol version the two sides negotiated. Left, what a voice-only device hears. Right, the Echo Show card. Everything the card shows, the voice already said.",
    ms: 11000,
    focus: "header .facts",
  },
  {
    caption:
      "A roofer knocks on the door. Six and a half thousand, three of it today, and water could get in tonight.",
    ms: 8000,
    focus: LAST_TURN,
    play: 2,
  },
  {
    caption:
      "CIRCA runs eighteen checks, sixteen citing published FTC or AARP guidance by URL. It will not tell you whether the contractor is trustworthy. It says so, then names what is worth knowing about: the unsolicited approach, and the size of the deposit.",
    ms: 14000,
    focus: CARD,
  },
  {
    caption:
      "Nothing in writing, and the damage was never shown. Two more questions become answerable, and the checklist grows. A rule that does not apply is reported, never dropped.",
    ms: 11000,
    focus: CARD,
    play: 1,
  },
  {
    caption:
      "Ask for a second opinion and it writes the request itself: where to look, not what to conclude. And it shows what it left out: the price, the company name, the urgency claim.",
    ms: 12000,
    focus: CARD,
    play: 1,
  },
  {
    caption:
      "Assessors are ordered by how little they gain from the answer. The first one sells assessments and not repairs, so the fee is the same whatever they find.",
    ms: 10000,
    focus: CARD,
    play: 2,
  },
  {
    caption: "Next morning, the assessment comes back: eighteen fifty, against sixty-five hundred.",
    ms: 6500,
    focus: LAST_TURN,
    play: 1,
  },
  {
    caption:
      "And here is the product. CIRCA will not say where that difference sits, because one quote was never itemised. That is a property of the document, not of the roof. Instead, it tells you what to ask for.",
    ms: 14000,
    focus: CARD,
    play: 1,
  },
  {
    caption: "The customer asks. That afternoon the contractor sends it broken down, and the same call runs again.",
    ms: 7000,
    focus: LAST_TURN,
    play: 2,
  },
  {
    caption:
      "Four thousand and thirty is work only one quote proposes. Four hundred and twenty is the same work at a different price. And two hundred is accounted for by neither, all of it on one line CIRCA could not classify: seal penetrations. That is the line to ask about.",
    ms: 17000,
    focus: CARD,
  },
  {
    caption: "The customer accepts the second quote. The baseline is written once, and never rewritten.",
    ms: 6500,
    focus: LAST_TURN,
    play: 1,
  },
  {
    caption:
      "Three weeks in, they want another twenty-two hundred for decking. CIRCA measures it against what was accepted, not what anyone remembers: not in what you agreed to, a hundred and nineteen per cent, nothing in writing yet.",
    ms: 12000,
    focus: CARD,
    play: 1,
  },
  {
    caption:
      "Ask them to put it in writing, and the whole record reads back: three quotes, what was accepted, counts by status, a timeline in plain words. No score, anywhere.",
    ms: 12000,
    focus: CARD,
    play: 2,
  },
  {
    caption:
      "Half the scenario corpus is ordinary repairs where the right answer is silence: zero false alarms on twenty-four. Six of fourteen quote pairs cannot be attributed, and it gets all six right. Sixteen injected documents, zero containment failures.",
    ms: 14000,
    card: {
      title: "Measured",
      lines: [
        "0 false alarms on 24 ordinary repairs",
        "6 of 6 refusals right, across 14 quote pairs",
        "0 containment failures on 16 injected documents",
        "6.2 ms at p95, against a 500 ms budget",
      ],
    },
  },
  {
    caption:
      "A hundred and seven tests, three corpora, Apache-2.0, on a clean clone with no AWS account. CIRCA. It will not tell you what it cannot know.",
    ms: 10000,
    card: { title: "CIRCA", lines: ["It will not tell you what it cannot know.", "github.com/Marc-Dvci/Circa"] },
  },
];

declare global {
  interface Window {
    __CIRCA_TIMING?: number[];
    CircaTour?: {
      beats: number;
      /** The narration, word for word, so the recorder can synthesise it. */
      captions: string[];
      /** The on-screen captions, for the subtitle file. */
      subtitles: string[];
      start: () => Promise<void>;
      running: boolean;
    };
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The caption bar owns the bottom of the window; a ring is clipped to the space above it. */
const CAPTION_RESERVE = 150;

function rectOf(selector: string): DOMRect | null {
  const el = document.querySelector(selector);
  if (!el) return null;
  const box = el.getBoundingClientRect();
  if (box.width === 0 && box.height === 0) return null;
  const top = Math.max(box.top, 8);
  const bottom = Math.min(box.bottom, window.innerHeight - CAPTION_RESERVE);
  if (bottom - top < 10) return null;
  return new DOMRect(box.left, top, box.width, bottom - top);
}

export function Tour({ controls }: { controls: TourControls }): JSX.Element | null {
  const [index, setIndex] = useState(-1);
  const [focusBox, setFocusBox] = useState<DOMRect | null>(null);
  const lastBox = useRef<DOMRect | null>(null);
  const started = useRef(false);
  const ctrl = useRef(controls);
  ctrl.current = controls;

  const start = useCallback(async () => {
    if (started.current) return;
    started.current = true;
    const timing = window.__CIRCA_TIMING;
    for (let i = 0; i < BEATS.length; i++) {
      const beat = BEATS[i]!;
      const budget = timing?.[i] ?? beat.ms;
      const openedAt = Date.now();
      setIndex(i);
      if (!beat.focus) setFocusBox(null);
      try {
        const plays = beat.play ?? 0;
        for (let n = 0; n < plays; n++) {
          await ctrl.current.playNext();
          // Let the card fetch its view and draw before the next call lands on
          // it, so a two-beat narration shows both results rather than one.
          await sleep(n + 1 < plays ? 900 : 500);
        }
      } catch (error) {
        console.warn(`tour beat ${i} action failed`, error);
      }
      if (beat.focus) {
        document.querySelector(beat.focus)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
        await sleep(650);
        setFocusBox(rectOf(beat.focus));
      }
      const remaining = budget - (Date.now() - openedAt);
      if (remaining > 0) await sleep(remaining);
    }
    // The closing card stays up.
  }, []);

  useEffect(() => {
    window.CircaTour = {
      beats: BEATS.length,
      captions: BEATS.map((b) => b.spoken ?? b.caption),
      subtitles: BEATS.map((b) => b.caption),
      start,
      running: true,
    };
    if (!new URLSearchParams(location.search).has("manual")) void start();
  }, [start]);

  useEffect(() => {
    if (index < 0) return;
    const selector = BEATS[index]?.focus;
    if (!selector) return;
    const tick = (): void => setFocusBox(rectOf(selector));
    const timer = setInterval(tick, 120);
    return () => clearInterval(timer);
  }, [index]);

  const beat = index >= 0 ? BEATS[index] : undefined;
  if (!beat) return null;
  if (focusBox) lastBox.current = focusBox;
  const ringBox = focusBox ?? lastBox.current;

  return (
    <>
      {beat.card ? (
        <div className="tour-card">
          <span className="tour-mark" aria-hidden="true" />
          <h1>{beat.card.title}</h1>
          {beat.card.lines.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      ) : null}
      {ringBox ? (
        <div
          className={`tour-ring ${focusBox && !beat.card ? "" : "hidden"}`}
          style={{ top: ringBox.top - 8, left: ringBox.left - 8, width: ringBox.width + 16, height: ringBox.height + 16 }}
        />
      ) : null}
      <div className={`tour-caption ${beat.card ? "on-card" : ""}`}>
        <div className="tour-progress">
          {BEATS.map((_, i) => (
            <span key={i} className={i <= index ? "on" : ""} />
          ))}
        </div>
        <p>{beat.caption}</p>
      </div>
    </>
  );
}
