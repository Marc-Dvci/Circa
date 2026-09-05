/**
 * The half of MCP Apps that runs inside the view.
 *
 * One string, inlined into every view, because a view is a single HTML resource
 * served over the MCP connection and there is no second request to fetch a
 * script from. The CSP declared in `_meta.ui` names no domains at all, which is
 * only truthful if the document really does load nothing.
 *
 * Message names follow SEP-1865 as finalised: host to view arrives as
 * `ui/notifications/tool-result`, `ui/notifications/tool-input` and
 * `ui/notifications/host-context-changed`; view to host goes out as
 * `ui/notifications/size-changed`, `ui/request-display-mode`, `ui/open-link`,
 * `ui/message` and plain `tools/call`. The simulator in `apps/simulator`
 * implements the host side of exactly these names, and `tests/mcp-apps.test.ts`
 * drives one against the other, so the two halves are checked against the spec
 * rather than against each other's habits.
 */
export const VIEW_RUNTIME = String.raw`
const HOST = (() => {
  let nextId = 1;
  const pending = new Map();
  const handlers = new Map();

  function post(message) {
    window.parent.postMessage(JSON.stringify({ jsonrpc: "2.0", ...message }), "*");
  }

  function request(method, params) {
    const id = "v" + nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      post({ id, method, params });
    });
  }

  function notify(method, params) {
    post({ method, params });
  }

  window.addEventListener("message", (event) => {
    let message;
    try {
      message = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
    } catch {
      return;
    }
    if (!message || message.jsonrpc !== "2.0") return;
    if (message.id !== undefined && pending.has(message.id)) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message || "host error"));
      else entry.resolve(message.result);
      return;
    }
    const handler = handlers.get(message.method);
    if (handler) handler(message.params ?? {});
  });

  // The host sizes the iframe from this. Measured after layout, and again on
  // every render, because a card that grows by one row and is never re-measured
  // is a card with its last line cut off on a device nobody tested on.
  function reportSize() {
    const height = Math.ceil(document.documentElement.scrollHeight);
    notify("ui/notifications/size-changed", { height });
  }

  return {
    on: (method, handler) => handlers.set(method, handler),
    notify,
    request,
    reportSize,
    callTool: (name, args) => request("tools/call", { name, arguments: args ?? {} }),
    displayMode: (mode) => request("ui/request-display-mode", { mode }),
    say: (text) => notify("ui/message", { text }),
    openLink: (url) => request("ui/open-link", { url }),
    updateContext: (text) => notify("ui/update-model-context", { text }),
  };
})();

function el(tag, attrs, children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== undefined && v !== null) node.setAttribute(k, String(v));
  }
  for (const child of [].concat(children || [])) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

function mount(children) {
  const root = document.getElementById("root");
  root.replaceChildren(...[].concat(children));
  HOST.reportSize();
}

let LAST_RESULT = null;

HOST.on("ui/notifications/tool-result", (params) => {
  const result = params.result ?? params;
  const data = result.structuredContent ?? result;
  LAST_RESULT = data;
  try {
    render(data);
  } catch (error) {
    mount(el("p", { class: "error" }, "This view could not render that result."));
  }
});

HOST.on("ui/notifications/host-context-changed", (params) => {
  document.body.dataset.displayMode = (params && params.displayMode) || "inline";
  if (LAST_RESULT) render(LAST_RESULT);
});

window.addEventListener("load", () => HOST.reportSize());
`;
