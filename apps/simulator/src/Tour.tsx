/**
 * The guided tour: `http://localhost:5173/?tour=1`.
 *
 * It is a demonstration, not a mock. Every beat below either narrates what is
 * already on screen or advances the same scripted arc `pnpm demo` runs, through
 * the same session, over the same Streamable HTTP connection, into the same
 * sandboxed card. The tour draws three things of its own: the title cards, the
 * lower third (a headline and the sentence being spoken), and a camera that
 * moves the whole page towards whatever the sentence is about.
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

/** Where the camera fits the focused element: above the lower third, or to its right. */
type Region = "above" | "right";

interface Beat {
  /** The headline in the lower third. Short, and the one thing the beat is about. */
  headline?: string;
  /** Shown under the headline and in the subtitles. Read aloud as written unless `spoken` says otherwise. */
  caption: string;
  /** What the narrator says when the caption is not how it is pronounced. Same words otherwise. */
  spoken?: string;
  ms: number;
  /** A CSS selector the camera moves to and the ring settles on, once the beat's action has landed. */
  focus?: string;
  /** Further selectors the camera keeps in the picture alongside `focus`. */
  frame?: string[];
  region?: Region;
  /** The most the camera magnifies for this beat. */
  zoom?: number;
  /** A full-bleed title card instead of the product. */
  card?: { title: string; lines: string[]; kicker?: string };
  /** How many scripted beats this narration beat plays. */
  play?: number;
}

const LAST_TURN = ".transcript-inner > .turn:last-of-type";
const PREVIOUS_TURN = ".transcript-inner > .turn:nth-last-child(2)";
const CARD = ".bezel";

const BEATS: Beat[] = [
  {
    caption: "CIRCA is an Alexa+ add-on. Tell it what a contractor offered, and it checks what can be checked before you pay.",
    spoken: "CIRCA is an Alexa plus add-on. Tell it what a contractor offered, and it checks what can be checked before you pay.",
    ms: 8000,
    card: { title: "CIRCA", lines: ["An Alexa+ add-on for home repairs.", "It checks the quote before you pay."] },
  },
  {
    caption:
      "A checklist of what is established and what is not. A second-opinion request with the first price removed. Two quotes compared line by line. And the scope you accepted, held for the whole job.",
    ms: 13000,
    card: {
      kicker: "What you get",
      title: "Four things",
      lines: [
        "A checklist: what is established, what is not.",
        "A second-opinion request, with the first price removed.",
        "Two quotes compared, line by line.",
        "The scope you accepted, held for the whole job.",
      ],
    },
  },
  {
    caption:
      "CIRCA never rates a contractor. It checks documents. When a price difference cannot be explained, it says so and tells you what to ask for.",
    ms: 10000,
    card: {
      title: "No score, ever",
      lines: ["It checks documents, which can be verified.", "When a difference cannot be explained, it says so."],
    },
  },
  {
    headline: "The Alexa+ simulator, connected to CIRCA over MCP",
    caption: "The Alexa+ simulator, connected to CIRCA over MCP. Left, what Alexa says. Right, the Echo Show card.",
    spoken: "The Alexa plus simulator, connected to CIRCA over MCP. Left, what Alexa says. Right, the Echo Show card.",
    ms: 8000,
    focus: "header .facts",
    region: "above",
    zoom: 1,
    play: 2,
  },
  {
    headline: "A roofer at the door: $6,500, with $3,000 today",
    caption: "A roofer knocks. Six thousand five hundred, three thousand of it today, and water could get in tonight.",
    ms: 8000,
    focus: PREVIOUS_TURN,
    frame: [LAST_TURN],
    region: "above",
    zoom: 1.5,
  },
  {
    headline: "18 checks. Two worth knowing about.",
    caption:
      "Eighteen checks run, sixteen citing FTC or AARP guidance. Two things are worth knowing about: the unsolicited approach, and the size of the deposit.",
    ms: 11000,
    focus: CARD,
    region: "right",
  },
  {
    headline: "Two more answers, and the checklist grows",
    caption: "Nothing in writing, and the damage was never shown. Two more questions become answerable, and the checklist grows.",
    ms: 9000,
    focus: CARD,
    region: "right",
    play: 1,
  },
  {
    headline: "The second-opinion request, with the first price removed",
    caption:
      "Ask for a second opinion and CIRCA writes the request. The first contractor's price, name and urgency claim are removed, and the card shows what was removed.",
    ms: 11000,
    focus: CARD,
    region: "right",
    play: 1,
  },
  {
    headline: "Assessors ranked by independence",
    caption: "Assessors are ranked by how little they gain from the answer. The first one sells assessments only.",
    ms: 8000,
    focus: CARD,
    region: "right",
    play: 1,
  },
  {
    headline: "The assessment: $1,850 against $6,500",
    caption: "Next morning, the assessment comes back: eighteen fifty, against sixty-five hundred.",
    ms: 6000,
    focus: LAST_TURN,
    region: "above",
    zoom: 1.5,
    play: 2,
  },
  {
    headline: "One quote has no line items. CIRCA will not split the difference.",
    caption:
      "Compare the two. CIRCA will not split the difference, because the first quote has no line items. It asks for the same quote with a price on each line.",
    ms: 12000,
    focus: CARD,
    region: "right",
    play: 1,
  },
  {
    headline: "Itemised. The same call runs again.",
    caption: "The contractor sends it broken down. The same call runs again.",
    ms: 7000,
    focus: LAST_TURN,
    region: "above",
    zoom: 1.4,
    play: 2,
  },
  {
    headline: "$4,030 in scope · $420 in price · $200 unexplained",
    caption:
      "Four thousand and thirty is work only one quote proposes. Four hundred and twenty is the same work at a different price. Two hundred sits on one unclassified line, seal penetrations. That is the line to ask about.",
    ms: 14000,
    focus: CARD,
    region: "right",
  },
  {
    headline: "The accepted scope becomes the baseline",
    caption: "The customer accepts the second quote. That scope is the baseline for the whole job.",
    ms: 7000,
    focus: CARD,
    region: "right",
    play: 1,
  },
  {
    headline: "Three weeks later: $2,200 more, outside the baseline",
    caption:
      "Three weeks later, the crew wants twenty-two hundred more for decking. CIRCA measures it against the baseline: decking is outside it, a hundred and nineteen per cent extra, nothing in writing yet.",
    ms: 12000,
    focus: CARD,
    region: "right",
    play: 1,
  },
  {
    headline: "The whole record, in plain words",
    caption:
      "Ask for it in writing, and the whole record reads back: three quotes, the accepted scope, every change by status. No score, anywhere.",
    ms: 11000,
    focus: CARD,
    region: "right",
    play: 2,
  },
  {
    caption:
      "Twenty-four ordinary repairs, zero false alarms. Six of fourteen quote pairs cannot be attributed, and CIRCA refuses all six. Sixteen injected documents, zero containment failures. Slowest tool, six point two milliseconds.",
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
      "A hundred and seven tests, three corpora, Apache 2.0, no AWS account needed. CIRCA. It will not tell you what it cannot know.",
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
      /** Which beats are title cards; the narration breathes longer after those. */
      cards: boolean[];
      start: () => Promise<void>;
      running: boolean;
      /** Set once the last beat has held for its whole duration. */
      done: boolean;
    };
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Resolves once neither pane is still scrolling. The transcript scrolls
 * smoothly to each new turn and a long one takes well over a second; a camera
 * aimed before it stops lands where the subject was, not where it settles.
 */
async function scrollsSettled(limitMs = 3000): Promise<void> {
  const panes = Array.from(document.querySelectorAll<HTMLElement>(".transcript, .device-pane"));
  let last = panes.map((p) => p.scrollTop);
  let still = 0;
  const started = Date.now();
  while (Date.now() - started < limitMs) {
    await sleep(100);
    const now = panes.map((p) => p.scrollTop);
    still = now.every((v, i) => v === last[i]) ? still + 1 : 0;
    last = now;
    if (still >= 3) return;
  }
}

/** The lower third owns the bottom left of the window; the camera keeps its subject clear of it. */
const LOWER_THIRD = { width: 760, height: 220 };
const MARGIN = 28;

interface Camera {
  k: number;
  x: number;
  y: number;
}

const HOME: Camera = { k: 1, x: 0, y: 0 };

function regionBox(region: Region): DOMRect {
  const w = window.innerWidth;
  const h = window.innerHeight;
  return region === "right"
    ? new DOMRect(LOWER_THIRD.width + MARGIN * 2, 0, w - LOWER_THIRD.width - MARGIN * 2, h)
    : new DOMRect(0, 0, w, h - LOWER_THIRD.height - MARGIN);
}

/** An element's rectangle in page layout coordinates, undoing the camera. */
function layoutRect(selector: string, camera: Camera): DOMRect | null {
  const el = document.querySelector(selector);
  if (!el) return null;
  const box = el.getBoundingClientRect();
  if (box.width === 0 && box.height === 0) return null;
  return new DOMRect((box.left - camera.x) / camera.k, (box.top - camera.y) / camera.k, box.width / camera.k, box.height / camera.k);
}

/** The smallest rectangle holding every selector that resolves. */
function layoutUnion(selectors: string[], camera: Camera): DOMRect | null {
  const rects = selectors.map((s) => layoutRect(s, camera)).filter((r): r is DOMRect => r !== null);
  if (rects.length === 0) return null;
  const left = Math.min(...rects.map((r) => r.left));
  const top = Math.min(...rects.map((r) => r.top));
  const right = Math.max(...rects.map((r) => r.right));
  const bottom = Math.max(...rects.map((r) => r.bottom));
  return new DOMRect(left, top, right - left, bottom - top);
}

/** The camera that fits `target` into `region`, magnifying up to `zoom`. */
function aim(target: DOMRect, region: DOMRect, zoom: number): Camera {
  const pad = 24;
  const k = Math.max(1, Math.min(zoom, (region.width - pad * 2) / target.width, (region.height - pad * 2) / target.height));
  const cx = region.left + region.width / 2;
  const cy = region.top + region.height / 2;
  let x = cx - (target.left + target.width / 2) * k;
  let y = cy - (target.top + target.height / 2) * k;
  // Never show past the page's edges: the page is the whole picture.
  x = Math.min(0, Math.max(window.innerWidth - window.innerWidth * k, x));
  y = Math.min(0, Math.max(window.innerHeight - window.innerHeight * k, y));
  return { k, x, y };
}

function applyCamera(camera: Camera): void {
  const stage = document.querySelector<HTMLElement>(".stage");
  if (!stage) return;
  stage.style.transform = `translate(${camera.x.toFixed(2)}px, ${camera.y.toFixed(2)}px) scale(${camera.k.toFixed(4)})`;
}

/** The ring's rectangle on screen, clipped to the region the camera was aimed at. */
function ringRect(selector: string, region: Region): DOMRect | null {
  const el = document.querySelector(selector);
  if (!el) return null;
  const box = el.getBoundingClientRect();
  if (box.width === 0 && box.height === 0) return null;
  const clip = regionBox(region);
  const top = Math.max(box.top, clip.top + 6);
  const bottom = Math.min(box.bottom, clip.bottom - 6);
  const left = Math.max(box.left, clip.left + 6);
  const right = Math.min(box.right, clip.right - 6);
  if (bottom - top < 10 || right - left < 10) return null;
  return new DOMRect(left, top, right - left, bottom - top);
}

export function Tour({ controls }: { controls: TourControls }): JSX.Element | null {
  const [index, setIndex] = useState(-1);
  const [focusBox, setFocusBox] = useState<DOMRect | null>(null);
  const [settled, setSettled] = useState(false);
  const camera = useRef<Camera>(HOME);
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
      setSettled(false);
      if (!beat.focus) {
        setFocusBox(null);
        camera.current = HOME;
        applyCamera(HOME);
      }
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
        await scrollsSettled();
        const target = layoutUnion([beat.focus, ...(beat.frame ?? [])], camera.current);
        if (target) {
          camera.current = aim(target, regionBox(beat.region ?? "above"), beat.zoom ?? 1.3);
          applyCamera(camera.current);
        }
        // The camera glides for 900 ms; the ring appears once it has arrived.
        await sleep(950);
        setSettled(true);
      }
      const remaining = budget - (Date.now() - openedAt);
      if (remaining > 0) await sleep(remaining);
    }
    // The closing card stays up.
    if (window.CircaTour) window.CircaTour.done = true;
  }, []);

  useEffect(() => {
    window.CircaTour = {
      beats: BEATS.length,
      captions: BEATS.map((b) => b.spoken ?? b.caption),
      subtitles: BEATS.map((b) => b.caption),
      cards: BEATS.map((b) => Boolean(b.card)),
      start,
      running: true,
      done: false,
    };
    if (!new URLSearchParams(location.search).has("manual")) void start();
  }, [start]);

  // The ring follows its subject every frame, so it stays on it while the
  // camera glides and while the transcript scrolls.
  useEffect(() => {
    if (index < 0) return;
    const beat = BEATS[index];
    const selector = beat?.focus;
    if (!selector) return;
    const region = beat?.region ?? "above";
    let frame = 0;
    const tick = (): void => {
      setFocusBox(ringRect(selector, region));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [index]);

  const beat = index >= 0 ? BEATS[index] : undefined;
  if (!beat) return null;
  const showRing = Boolean(focusBox && settled && !beat.card);

  return (
    <>
      {beat.card ? (
        <div className="tour-card" key={`card-${index}`}>
          <span className="tour-mark" aria-hidden="true" />
          {beat.card.kicker ? <p className="kicker">{beat.card.kicker}</p> : null}
          <h1>{beat.card.title}</h1>
          <div className="lines">
            {beat.card.lines.map((line, n) => (
              <p key={line} style={{ animationDelay: `${420 + n * 260}ms` }}>
                {line}
              </p>
            ))}
          </div>
        </div>
      ) : null}
      {focusBox ? (
        <div
          className={`tour-ring ${showRing ? "" : "hidden"}`}
          style={{ top: focusBox.top - 8, left: focusBox.left - 8, width: focusBox.width + 16, height: focusBox.height + 16 }}
        />
      ) : null}
      {beat.card ? null : (
        <div className="tour-caption" key={`caption-${index}`}>
          <div className="tour-progress">
            {BEATS.map((_, i) => (
              <span key={i} className={i <= index ? "on" : ""} />
            ))}
          </div>
          {beat.headline ? <h2>{beat.headline}</h2> : null}
          <p>{beat.caption}</p>
        </div>
      )}
    </>
  );
}
