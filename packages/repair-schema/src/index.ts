/**
 * `@circa/repair-schema` — a machine-readable representation of home-service
 * quotes, agreements and change orders for agentic systems.
 *
 * The package contains no I/O, no model call and no network. It is the wire
 * format two agents would have to agree on before either could say anything
 * defensible about a repair, and it is published separately from the product
 * for exactly that reason.
 *
 * Apache-2.0.
 */

export * from "./money.js";
export * from "./work.js";
export * from "./quote.js";
export * from "./verification.js";
export * from "./comparison.js";
export * from "./case.js";

export const REPAIR_SCHEMA_VERSION = "0.1.0";
