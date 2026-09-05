import { randomUUID } from "node:crypto";

/**
 * Identifiers.
 *
 * Prefixed and short, because they appear in voice transcripts and on a screen
 * read from across a kitchen. `case_7QK4` is something a person can read back;
 * a UUID is not.
 *
 * A deterministic mode exists for the demo and the test suite. It is not a
 * default and it is not reachable from the server: an id generator whose
 * sequence depends on process state would make two concurrent cases collide.
 */

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I, O, 0, 1

export type IdKind = "case" | "offer" | "quote" | "change" | "evt" | "ev" | "req" | "base" | "doc";

let deterministic: { counter: number } | null = null;

/** Test and demo only. Returns a restore function. */
export function useDeterministicIds(seed = 0): () => void {
  const previous = deterministic;
  deterministic = { counter: seed };
  return () => {
    deterministic = previous;
  };
}

function randomSuffix(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length];
  return out;
}

export function newId(kind: IdKind, length = 6): string {
  if (deterministic) {
    deterministic.counter += 1;
    return `${kind}_${String(deterministic.counter).padStart(length, "0")}`;
  }
  return `${kind}_${randomSuffix(length)}`;
}

/** For anything that must be globally unique and is never spoken. */
export function uuid(): string {
  return randomUUID();
}
