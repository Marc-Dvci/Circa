import { VIEW_RUNTIME } from "./runtime.js";
import { VIEW_STYLE } from "./style.js";

/**
 * The six views.
 *
 * Each one renders a payload the server has already reduced to rows and
 * sentences. The views contain no product logic — no thresholds, no wording
 * decisions, no arithmetic on money — because the same payload has to be spoken
 * by a voice-only Echo, printed by the CLI and read aloud from a transcript, and
 * the moment a screen starts deciding what a case means, those three stop
 * agreeing.
 *
 * Voice-only is the baseline. Everything a view shows, `speech` already said.
 */

export interface ViewDefinition {
  uri: string;
  name: string;
  title: string;
  description: string;
  render: string;
  /** Fullscreen views ask the host for room; inline ones never do. */
  prefersFullscreen?: boolean;
}

const VERIFICATION = String.raw`
function render(data) {
  const rows = (data.rows || []).map((r) =>
    el("div", { class: "row" }, [
      el("span", { class: "label" }, r.label),
      el("span", { class: "value" + (r.attention ? " attention" : "") }, r.value),
    ]),
  );
  const open = (data.counts && (data.counts.attention + data.counts.verify)) || 0;
  const actions = (data.actions || []).map((a, i) =>
    el("button", {
      class: i === 0 ? "" : "secondary",
      onClick: () => HOST.callTool(a.tool, a.arguments),
    }, a.label),
  );
  mount([
    el("h1", {}, data.headline || "Repair"),
    el("p", { class: "headline" },
      open === 0 ? "Everything I can check is done" : open + (open === 1 ? " thing to settle" : " things to settle")),
    data.speech ? el("p", { class: "sub" }, data.speech) : null,
    rows.length ? el("div", { class: "rows" }, rows) : null,
    data.refusal ? el("p", { class: "note refusal" }, data.refusal) : null,
    actions.length ? el("div", { class: "actions" }, actions) : null,
  ]);
}
`;

const COMPARISON = String.raw`
let expanded = false;

function render(data) {
  const pair = el("div", { class: "pair" }, [
    el("div", {}, [
      el("div", { class: "who" }, data.quoteA.name),
      el("div", { class: "amount" }, data.quoteA.total),
    ]),
    el("div", {}, [
      el("div", { class: "who" }, data.quoteB.name),
      el("div", { class: "amount" }, data.quoteB.total),
    ]),
  ]);
  const rows = (data.rows || []).map((r) =>
    el("div", { class: "row" }, [
      el("span", { class: "label" }, r.label),
      el("span", { class: "value" + (r.attention ? " attention" : "") }, r.value),
    ]),
  );
  mount([
    el("h1", {}, "Two quotes"),
    el("p", { class: "headline" }, data.headline),
    pair,
    rows.length ? el("div", { class: "rows", style: "margin-top:14px" }, rows) : null,
    data.refusal ? el("p", { class: "note refusal" }, data.refusal) : null,
    expanded
      ? el("div", { class: "detail" }, (data.detail || "").split("\n").map((line) => el("p", {}, line)))
      : null,
    el("div", { class: "actions" }, [
      el("button", {
        onClick: () => {
          expanded = !expanded;
          // Ask for the room first, then redraw into it. Drawing the long form
          // into an inline card and hoping the host grows it is how a card ends
          // up with its last three lines below the fold.
          if (expanded) HOST.displayMode("fullscreen").then(() => render(data), () => render(data));
          else render(data);
        },
      }, expanded ? "Hide the detail" : "Explain the difference"),
      data.actions && data.actions[0]
        ? el("button", { class: "secondary", onClick: () => HOST.callTool(data.actions[0].tool, data.actions[0].arguments) }, data.actions[0].label)
        : null,
    ]),
  ]);
}
`;

const CHANGE = String.raw`
function render(data) {
  mount([
    el("h1", {}, "New request"),
    el("p", { class: "headline" }, data.amount || data.describedAs),
    el("p", { class: "sub" }, data.describedAs),
    el("div", { class: "rows" }, (data.rows || []).map((r) =>
      el("div", { class: "row" }, [
        el("span", { class: "label" }, r.label),
        el("span", { class: "value" + (r.attention ? " attention" : "") }, r.value),
      ]),
    )),
    data.refusal ? el("p", { class: "note refusal" }, data.refusal) : null,
    el("div", { class: "actions" }, (data.actions || []).map((a, i) =>
      el("button", { class: i === 0 ? "" : "secondary", onClick: () => HOST.callTool(a.tool, a.arguments) }, a.label),
    )),
  ]);
}
`;

const PROVIDERS = String.raw`
function render(data) {
  mount([
    el("h1", {}, "Independent assessment"),
    el("p", { class: "headline" }, (data.matches || []).length + " available"),
    el("ul", { class: "plain" }, (data.matches || []).map((m) =>
      el("li", {}, [
        el("div", { class: "name" }, m.name),
        el("div", { class: "why" }, m.terms),
        el("div", { class: "why" }, m.reasons[0]),
        el("div", { class: "actions" }, [
          el("button", {
            onClick: () => {
              // A choice made by tapping is a choice the conversation never
              // heard. Telling the model which one was picked is what makes
              // "book that one" resolve to the right business afterwards.
              HOST.updateContext("The customer picked " + m.name + " (" + m.id + ") from the assessor list on the screen.");
              HOST.callTool("request_second_opinion", { caseId: data.caseId, providerId: m.id });
            },
          }, "Send the scope"),
        ]),
      ]),
    )),
    el("p", { class: "simulated" }, data.notice),
  ]);
}
`;

const SCOPE = String.raw`
function render(data) {
  mount([
    el("h1", {}, "Independent assessment request"),
    el("p", { class: "headline" }, data.headline),
    el("p", { class: "sub" }, data.speech),
    el("div", { class: "rows" }, (data.rows || []).map((r) =>
      el("div", { class: "row" }, [
        el("span", { class: "label" }, r.label),
        el("span", { class: "value" + (r.attention ? " attention" : "") }, r.value),
      ]),
    )),
    el("p", { class: "note refusal" }, data.refusal || ""),
    el("div", { class: "actions" }, (data.actions || []).map((a, i) =>
      el("button", { class: i === 0 ? "" : "secondary", onClick: () => HOST.callTool(a.tool, a.arguments) }, a.label),
    )),
  ]);
}
`;

const DOSSIER = String.raw`
function render(data) {
  const events = (data.timeline || []).map((e) =>
    el("div", {}, [el("div", { class: "when" }, e.when), el("div", {}, e.summary)]),
  );
  mount([
    el("h1", {}, data.headline),
    el("p", { class: "headline" }, data.statusLabel),
    el("div", { class: "rows" }, (data.rows || []).map((r) =>
      el("div", { class: "row" }, [
        el("span", { class: "label" }, r.label),
        el("span", { class: "value" + (r.attention ? " attention" : "") }, r.value),
      ]),
    )),
    el("div", { class: "timeline" }, events),
    (data.quotes || []).length >= 2
      ? el("div", { class: "actions" }, [
          // ui/message, used for what it is for: the view speaks as the
          // customer, so a comparison run from a tap appears in the transcript.
          // On this product the transcript is the record, and a tap that
          // changed the case without appearing in it would make the record
          // wrong in the one place it is supposed to be right.
          el("button", { onClick: () => HOST.say("Compare the quotes") }, "Compare the quotes"),
        ])
      : null,
  ]);
}
`;

export const VIEWS: readonly ViewDefinition[] = [
  {
    uri: "ui://circa/verification",
    name: "circa-verification",
    title: "Repair checklist",
    description: "What has been established about a repair offer and what has not, as a checklist with no score.",
    render: VERIFICATION,
  },
  {
    uri: "ui://circa/comparison",
    name: "circa-comparison",
    title: "Quote comparison",
    description: "Two quotes side by side, with the part of the difference the documents can and cannot account for.",
    render: COMPARISON,
    prefersFullscreen: true,
  },
  {
    uri: "ui://circa/change",
    name: "circa-change",
    title: "Change review",
    description: "A newly proposed piece of work measured against the scope the customer accepted.",
    render: CHANGE,
  },
  {
    uri: "ui://circa/providers",
    name: "circa-providers",
    title: "Independent assessors",
    description: "Businesses that can give a second opinion, ordered by how little they gain from the answer.",
    render: PROVIDERS,
  },
  {
    uri: "ui://circa/scope",
    name: "circa-scope",
    title: "Assessment request",
    description:
      "The independent assessment request CIRCA generated, and the list of things it deliberately withheld from it.",
    render: SCOPE,
  },
  {
    uri: "ui://circa/dossier",
    name: "circa-dossier",
    title: "Repair dossier",
    description: "The whole record of a repair: quotes, the accepted scope, changes and the timeline.",
    render: DOSSIER,
    prefersFullscreen: true,
  },
];

export const UI_MIME_TYPE = "text/html;profile=mcp-app";

export function viewHtml(view: ViewDefinition): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${view.title}</title>
<style>${VIEW_STYLE}</style>
</head>
<body data-display-mode="inline">
<main id="root"><p class="sub">Waiting for the result…</p></main>
<script>${VIEW_RUNTIME}
${view.render}
</script>
</body>
</html>`;
}

/**
 * `_meta.ui` for the resource.
 *
 * `csp.connectDomains` and `csp.resourceDomains` are both empty, and that is a
 * claim about the document rather than a preference: these views fetch nothing,
 * load no font and call no analytics. A view that declared a domain would be a
 * view a contractor's document could eventually reach through.
 */
export function viewMeta(view: ViewDefinition): Record<string, unknown> {
  return {
    ui: {
      csp: { connectDomains: [], resourceDomains: [] },
      prefersBorder: true,
      ...(view.prefersFullscreen ? { preferredDisplayMode: "fullscreen" } : {}),
    },
  };
}
