import { z } from "zod";

/**
 * The work unit is the atom of this schema.
 *
 * Two quotes never use the same words. "Repair chimney area" and "Remove
 * existing step and counter flashing, install new aluminium flashing, seal
 * penetrations" are the same work; "replace the roof" and "replace the roof
 * decking" are not, and differ by four thousand dollars. Comparison happens on
 * work units, never on text.
 */

export const WorkActionSchema = z.enum([
  "REPLACE",
  "REPAIR",
  "INSTALL",
  "REMOVE",
  "INSPECT",
  "CLEAN",
  "SEAL",
  "TEST",
  "PROTECT",
  "DISPOSE",
  "PERMIT",
  "UNKNOWN",
]);
export type WorkAction = z.infer<typeof WorkActionSchema>;

export const UnitSchema = z.enum([
  "each",
  "sq_ft",
  "linear_ft",
  "square", // roofing: 100 sq ft
  "hour",
  "day",
  "lot", // "the whole thing", the unit a lump sum implies
]);
export type Unit = z.infer<typeof UnitSchema>;

/**
 * `component` is a taxonomy id such as `roof.chimney_flashing`. The taxonomy
 * lives in a separate package so this schema stays a wire format rather than a
 * dependency on one vendor's vocabulary; the id is validated for shape here and
 * for membership by the taxonomy.
 */
export const ComponentIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/, "component id looks like `trade.component`");
export type ComponentId = z.infer<typeof ComponentIdSchema>;

export const WorkUnitSchema = z.object({
  component: ComponentIdSchema,
  action: WorkActionSchema,
  quantity: z.number().positive().optional(),
  unit: UnitSchema.optional(),
});
export type WorkUnit = z.infer<typeof WorkUnitSchema>;

/** Stable key for set operations. Quantity is deliberately not part of it. */
export function workKey(work: Pick<WorkUnit, "component" | "action">): string {
  return `${work.component}#${work.action}`;
}

/**
 * Whether two actions describe work that overlaps enough to be called the same.
 *
 * REPLACE subsumes REPAIR on the same component: a quote that replaces the
 * flashing has done everything a quote that repairs it would have done, so the
 * two are comparable and the difference is one of degree, not of scope. INSPECT
 * subsumes nothing — an inspection is not a repair, and treating it as partial
 * coverage of one is how a $95 assessment gets compared against a $6,500 job.
 */
const SUBSUMES: Partial<Record<WorkAction, readonly WorkAction[]>> = {
  REPLACE: ["REPAIR", "INSTALL", "REMOVE", "SEAL"],
  INSTALL: ["REPAIR"],
  REPAIR: ["SEAL"],
};

export function actionsOverlap(a: WorkAction, b: WorkAction): boolean {
  if (a === b) return true;
  if (a === "UNKNOWN" || b === "UNKNOWN") return false;
  return (SUBSUMES[a] ?? []).includes(b) || (SUBSUMES[b] ?? []).includes(a);
}
