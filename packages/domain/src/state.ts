import type { CaseStatus } from "#schema";

/**
 * The case state machine.
 *
 * Held explicitly rather than inferred from which fields are populated, because
 * the interesting states are the ones nothing is populated in: a case that has
 * been waiting a week for a second opinion looks exactly like a case where one
 * was never requested, unless the transition was recorded when it happened.
 *
 * Transitions are permissive forwards and almost closed backwards. A homeowner
 * can reopen a decision; they cannot un-accept a baseline, because the baseline
 * is the record of what they agreed and rewriting it is the one thing that would
 * make the change-order review worthless.
 */
export const TRANSITIONS: Readonly<Record<CaseStatus, readonly CaseStatus[]>> = {
  NEW: ["OFFER_CAPTURED", "CLOSED"],
  // A homeowner who has an offer and simply accepts it is an ordinary path, not
  // a skipped step. The product's job is to make the checks easy to run, not to
  // make the decision unreachable until they have been.
  OFFER_CAPTURED: ["VERIFYING", "SCOPE_NORMALISED", "QUOTES_COMPARABLE", "DECISION_RECORDED", "CLOSED"],
  VERIFYING: ["VERIFYING", "SCOPE_NORMALISED", "SECOND_OPINION_REQUESTED", "DECISION_RECORDED", "CLOSED"],
  SCOPE_NORMALISED: ["SECOND_OPINION_REQUESTED", "QUOTES_COMPARABLE", "VERIFYING", "DECISION_RECORDED", "CLOSED"],
  SECOND_OPINION_REQUESTED: ["QUOTES_COMPARABLE", "SECOND_OPINION_REQUESTED", "VERIFYING", "CLOSED"],
  QUOTES_COMPARABLE: ["QUOTES_COMPARABLE", "DECISION_RECORDED", "SECOND_OPINION_REQUESTED", "VERIFYING", "CLOSED"],
  DECISION_RECORDED: ["WORK_IN_PROGRESS", "VERIFYING", "CLOSED"],
  WORK_IN_PROGRESS: ["CHANGE_PROPOSED", "COMPLETED", "CLOSED"],
  CHANGE_PROPOSED: ["CHANGE_PROPOSED", "WORK_IN_PROGRESS", "COMPLETED", "CLOSED"],
  COMPLETED: ["CLOSED", "CHANGE_PROPOSED"],
  CLOSED: [],
};

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: CaseStatus,
    readonly to: CaseStatus,
  ) {
    super(`a case cannot go from ${from} to ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export function canTransition(from: CaseStatus, to: CaseStatus): boolean {
  return (TRANSITIONS[from] ?? []).includes(to);
}

export function assertTransition(from: CaseStatus, to: CaseStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

/** Every state reachable from NEW. Used by the suite to prove none is orphaned. */
export function reachableStates(): Set<CaseStatus> {
  const seen = new Set<CaseStatus>(["NEW"]);
  const stack: CaseStatus[] = ["NEW"];
  while (stack.length) {
    for (const next of TRANSITIONS[stack.pop()!] ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      stack.push(next);
    }
  }
  return seen;
}
