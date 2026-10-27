/**
 * @file
 * Kubernetes quantities — 250m, 512Mi, 20Gi — as numbers, so two can
 * be compared.
 *
 * Only for comparing, as when saying a storage quota is smaller than
 * the Postgres a namespace will need. What's sent to the API is always
 * the text that was typed.
 */

// What Kubernetes accepts, near enough: a number and an optional suffix
export const QUANTITY = /^\d+(\.\d+)?(m|k|M|G|T|P|E|Ki|Mi|Gi|Ti|Pi|Ei)?$/;

const SUFFIXES: Record<string, number> = {
  "": 1,
  m: 1e-3,
  k: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  P: 1e15,
  E: 1e18,
  Ki: 2 ** 10,
  Mi: 2 ** 20,
  Gi: 2 ** 30,
  Ti: 2 ** 40,
  Pi: 2 ** 50,
  Ei: 2 ** 60,
};

/**
 * A quantity's value, or undefined when it isn't one.
 *
 * @param text
 * @returns
 */
export function parseQuantity(text: string | undefined): number | undefined {
  const match = /^(\d+(?:\.\d+)?)([a-zA-Z]*)$/.exec(text?.trim() ?? "");
  const multiplier = SUFFIXES[match?.[2] ?? "?"];
  return match === null || multiplier === undefined ? undefined : Number(match[1]) * multiplier;
}

/**
 * A byte count in the binary units people use for volumes, rounded to
 * one place.
 *
 * @param bytes
 * @returns
 */
export function formatBytes(bytes: number): string {
  const units = ["", "Ki", "Mi", "Gi", "Ti", "Pi"];
  let value = bytes;
  let unit = 0;
  while (Math.abs(value) >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${Number(value.toFixed(1))}${units[unit]}`;
}
