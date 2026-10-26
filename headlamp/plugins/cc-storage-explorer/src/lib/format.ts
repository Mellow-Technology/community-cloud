/**
 * @file
 * Turning storage numbers into something a person can read.
 *
 * Every number in these views arrives as a count of bytes or of
 * inodes, and the same number is shown in a gauge legend, a table cell
 * and a name/value row. Formatting it at each of those places is how
 * the same disk ends up reading as "467.9 GB" in one view and
 * "435.7 GiB" in the next, so it is done once here.
 *
 * Binary units throughout, because that is what the kubelet reports
 * and what Kubernetes quantities mean: a "20Gi" volume is 20 * 1024^3
 * bytes, and showing it as 21.5 GB invites someone to go looking for
 * the missing gigabyte.
 *
 * The thresholds live here too, so that a gauge turning amber and a
 * usage bar turning amber always mean the same thing.
 */

// Binary byte units, in the order they are stepped through.
const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB'];

// Suffixes for plain counts, which are not sizes and so step by 1000.
const COUNT_UNITS = ['', 'K', 'M', 'G', 'T'];

/**
 * What is shown in place of a number the cluster did not report.
 *
 * An em dash rather than "0" or "unknown": a filesystem the kubelet
 * said nothing about is not a filesystem with nothing on it, and the
 * difference matters when the reason is a missing permission.
 */
export const NOT_AVAILABLE = '—';

// Usage above this is worth noticing.
export const WARNING_THRESHOLD = 0.75;

// Usage above this is worth doing something about.
export const CRITICAL_THRESHOLD = 0.9;

export type UsageSeverity = 'ok' | 'warning' | 'critical';

/**
 * A byte count in binary units, e.g. `12.4 GiB`.
 *
 * Bytes are shown whole, since a fraction of a byte is noise, and
 * everything above them to one decimal place.
 *
 * @param bytes
 * @param fractionDigits
 * @returns
 */
export function formatBytes(bytes?: number | null, fractionDigits = 1): string {
  if (bytes === undefined || bytes === null || Number.isNaN(bytes)) {
    return NOT_AVAILABLE;
  }

  let value = Math.abs(bytes);
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const sign = bytes < 0 ? '-' : '';
  return `${sign}${value.toFixed(unitIndex === 0 ? 0 : fractionDigits)} ${BYTE_UNITS[unitIndex]}`;
}

/**
 * A count of things that are not bytes, such as inodes.
 *
 * @param count
 * @returns
 */
export function formatCount(count?: number | null): string {
  if (count === undefined || count === null || Number.isNaN(count)) {
    return NOT_AVAILABLE;
  }

  let value = count;
  let unitIndex = 0;
  while (value >= 1000 && unitIndex < COUNT_UNITS.length - 1) {
    value /= 1000;
    unitIndex += 1;
  }

  return unitIndex === 0 ? `${value}` : `${value.toFixed(1)}${COUNT_UNITS[unitIndex]}`;
}

/**
 * How full something is, as a ratio in [0, 1].
 *
 * Null when it cannot be worked out, which is a different thing from
 * zero and is what the gauges and bars use to decide whether to draw
 * anything at all. A total of zero counts as unknown rather than full:
 * a filesystem of no size is a filesystem nobody measured.
 *
 * @param used
 * @param total
 * @returns
 */
export function usageFraction(used?: number | null, total?: number | null): number | null {
  if (!total || used === undefined || used === null || Number.isNaN(used)) {
    return null;
  }

  return Math.min(Math.max(used / total, 0), 1);
}

/**
 * A ratio as a percentage.
 *
 * @param fraction
 * @param fractionDigits
 * @returns
 */
export function formatPercent(fraction: number | null | undefined, fractionDigits = 0): string {
  if (fraction === undefined || fraction === null) {
    return NOT_AVAILABLE;
  }

  return `${(fraction * 100).toFixed(fractionDigits)}%`;
}

/**
 * Which band a usage ratio falls in.
 *
 * An unknown ratio is "ok" rather than a band of its own, because the
 * places that colour by severity are already showing that the number
 * is missing and should not also paint it as a problem.
 *
 * @param fraction
 * @returns
 */
export function usageSeverity(fraction: number | null | undefined): UsageSeverity {
  if (fraction === undefined || fraction === null) {
    return 'ok';
  }
  if (fraction >= CRITICAL_THRESHOLD) {
    return 'critical';
  }
  if (fraction >= WARNING_THRESHOLD) {
    return 'warning';
  }

  return 'ok';
}
