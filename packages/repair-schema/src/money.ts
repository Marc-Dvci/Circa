/**
 * Money is integer cents. Never a float.
 *
 * A quote comparison subtracts, sums and apportions amounts dozens of times per
 * case; at 0.01 resolution a float turns `$6,500.00 - $1,850.00 - $4,650.00`
 * into a residual of 9.094947017729282e-13, and the product would then report an
 * "unexplained difference of $0.00" that is not zero. Every amount in this
 * package is an integer number of cents, and the only place a decimal exists is
 * the formatter.
 */

/** An integer number of cents. Negative values are legal (a credit). */
export type Cents = number;

export function isCents(value: unknown): value is Cents {
  return typeof value === "number" && Number.isSafeInteger(value);
}

/** Parse "$6,500", "6500.00", "6,500.50" into cents. Returns null if there is no number. */
export function parseCents(text: string): Cents | null {
  const match = /(-?)\$?\s*([0-9][0-9,]*)(?:\.([0-9]{1,2}))?/.exec(text);
  if (!match) return null;
  const [, sign, whole, frac] = match;
  const dollars = Number(whole!.replace(/,/g, ""));
  if (!Number.isFinite(dollars)) return null;
  const cents = frac ? Number(frac.padEnd(2, "0")) : 0;
  const total = dollars * 100 + cents;
  return sign === "-" ? -total : total;
}

/** "$6,500" — whole dollars when exact, two decimals otherwise. */
export function formatCents(cents: Cents): string {
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const remainder = abs % 100;
  const grouped = dollars.toLocaleString("en-US");
  const body = remainder === 0 ? `$${grouped}` : `$${grouped}.${String(remainder).padStart(2, "0")}`;
  return negative ? `-${body}` : body;
}

/**
 * Split `total` across `weights` so the parts sum to exactly `total`.
 *
 * Used when a lump sum has to be apportioned across the work it describes.
 * Largest-remainder, so the rounding error goes to the largest share rather than
 * appearing as a residual the comparison engine would then have to explain.
 */
export function apportion(total: Cents, weights: readonly number[]): Cents[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0 || weights.length === 0) return weights.map(() => 0);
  const exact = weights.map((w) => (total * w) / sum);
  const floors = exact.map((v) => Math.floor(v));
  let shortfall = total - floors.reduce((a, b) => a + b, 0);
  const order = exact
    .map((v, i) => ({ i, remainder: v - Math.floor(v) }))
    .sort((a, b) => b.remainder - a.remainder);
  const out = [...floors];
  for (const { i } of order) {
    if (shortfall <= 0) break;
    out[i] = out[i]! + 1;
    shortfall -= 1;
  }
  return out;
}
