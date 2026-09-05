/**
 * One stylesheet for every view.
 *
 * Sized for a device on a kitchen counter, read by somebody standing two metres
 * away with a contractor in the room. Amazon's display guidance asks for very
 * low information density — a title, one or two supporting fields, one clear
 * next action — and the constraint here is stronger than that, because the
 * screen is glanced at rather than read.
 *
 * There is no colour that means good or bad. A green tick beside a contractor's
 * name is a verdict about a person, which is the one thing this product does not
 * issue, so status is carried by the word and by weight, and the only accent is
 * on the thing the customer can act on next.
 */
export const VIEW_STYLE = String.raw`
:root {
  color-scheme: dark;
  --bg: #0b1016;
  --panel: #131c26;
  --line: #22303d;
  --ink: #f2f6fa;
  --muted: #93a4b5;
  --accent: #6fd0e8;
  --attention: #f0c674;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: var(--bg); color: var(--ink); }
body {
  font-family: "Amazon Ember", "Segoe UI", system-ui, -apple-system, sans-serif;
  font-size: 17px;
  line-height: 1.45;
  padding: 20px 24px 22px;
  -webkit-font-smoothing: antialiased;
}
body[data-display-mode="fullscreen"] { font-size: 19px; padding: 32px 44px; }

h1 {
  font-size: 13px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--muted);
  font-weight: 600;
  margin: 0 0 10px;
}
.headline { font-size: 27px; font-weight: 600; line-height: 1.2; margin: 0 0 16px; }
body[data-display-mode="fullscreen"] .headline { font-size: 34px; }
.sub { color: var(--muted); margin: -8px 0 16px; }

.rows { display: grid; gap: 1px; background: var(--line); border-radius: 10px; overflow: hidden; }
.row {
  display: flex; justify-content: space-between; align-items: baseline; gap: 16px;
  background: var(--panel); padding: 11px 14px;
}
.row .label { color: var(--muted); }
.row .value { font-variant-numeric: tabular-nums; text-align: right; }
.row .value.attention { color: var(--attention); }

.pair { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; background: var(--line); border-radius: 10px; overflow: hidden; }
.pair > div { background: var(--panel); padding: 14px; }
.pair .who { color: var(--muted); font-size: 14px; margin-bottom: 4px; }
.pair .amount { font-size: 26px; font-variant-numeric: tabular-nums; }

.note {
  margin: 16px 0 0; padding: 12px 14px; border-left: 3px solid var(--line);
  color: var(--muted); font-size: 15px;
}
.note.refusal { border-left-color: var(--attention); color: var(--ink); }

/* The long form of a comparison, shown only when the host has granted the room. */
.detail { margin: 16px 0 0; display: grid; gap: 8px; }
.detail p { margin: 0; color: var(--muted); }
.detail p:first-child { color: var(--ink); }
.error { color: var(--attention); }

.actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 18px; }
button {
  font: inherit; font-weight: 600; color: var(--bg); background: var(--accent);
  border: 0; border-radius: 999px; padding: 11px 20px; cursor: pointer;
}
button.secondary { background: transparent; color: var(--accent); box-shadow: inset 0 0 0 1px var(--line); }
button:focus-visible { outline: 3px solid var(--accent); outline-offset: 3px; }

ul.plain { list-style: none; margin: 12px 0 0; padding: 0; display: grid; gap: 10px; }
ul.plain li { background: var(--panel); border-radius: 10px; padding: 12px 14px; }
ul.plain .name { font-weight: 600; }
ul.plain .why { color: var(--muted); font-size: 14.5px; margin-top: 4px; }

.timeline { border-left: 2px solid var(--line); margin: 12px 0 0; padding: 0 0 0 16px; display: grid; gap: 14px; }
.timeline .when { color: var(--muted); font-size: 13px; }
.simulated {
  margin-top: 16px; font-size: 13px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted);
}
@media (prefers-reduced-motion: no-preference) { .rows, .pair, ul.plain li { transition: none; } }
`;
