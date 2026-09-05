import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./styles.css";

/**
 * The Alexa+ simulator.
 *
 * The hackathon allows a simulated Alexa+ experience *instead of* MCP. This one
 * is both: the add-on is a real MCP server speaking Streamable HTTP at protocol
 * 2025-11-25, and this page is a host that connects to it with the SDK's own
 * client and implements the host half of MCP Apps. Nothing on the screen is
 * mocked, and the status bar prints the version the two sides negotiated so that
 * can be checked rather than believed.
 */

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
