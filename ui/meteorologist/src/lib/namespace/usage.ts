/**
 * @file
 * What a namespace is using of its quota, as figures for stat displays:
 * CPU in cores, memory and storage in whichever binary unit the limit
 * reads best in, so the amount used and the limit share it.
 */
import { bytesIn } from "../cluster";
import type { ResourceQuota } from "../kube/types";
import { parseQuantity } from "../quantity";

export interface QuotaFigure {
  key: string;
  label: string;
  used: string;
  limit: string;
  unit?: string;
  // Whether used and limit are numbers in the same unit, so a meter
  // of one against the other means something
  comparable: boolean;
}

// bytesIn's units, for scaling by the one it picks: it rounds to one
// place, which is too few for a small amount used
const BYTE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];

// What a quota's keys mean, in the order they're shown, and whether
// they count cores or bytes
const QUOTA_FIGURES: Array<{ key: string; label: string; kind: "cores" | "bytes" }> = [
  { key: "requests.cpu", label: "CPU reserved", kind: "cores" },
  { key: "limits.memory", label: "Memory", kind: "bytes" },
  { key: "requests.storage", label: "Storage", kind: "bytes" },
];

/**
 * A figure with at most one decimal place, or two below 1, where one
 * would turn 256Mi of a 2Gi limit into 0.3, and none when it's whole.
 *
 * @param value
 * @returns
 */
function figure(value: number): string {
  return String(Number(value.toFixed(Math.abs(value) < 1 ? 2 : 1)));
}

/**
 * The quota's limits that are set, with how much of each is used. One
 * that can't be read as a quantity is shown as Kubernetes wrote it.
 *
 * @param quota
 * @returns
 */
export function quotaFigures(quota: ResourceQuota | undefined): QuotaFigure[] {
  const hard = quota?.status?.hard ?? {};
  const used = quota?.status?.used ?? {};
  return QUOTA_FIGURES.filter(({ key }) => hard[key] !== undefined).map(({ key, label, kind }) => {
    const usedText = used[key] ?? "0";
    const limitText = hard[key]!;
    const usedValue = parseQuantity(usedText);
    const limitValue = parseQuantity(limitText);
    if (usedValue === undefined || limitValue === undefined) {
      return { key, label, used: usedText, limit: limitText, comparable: false };
    }
    if (kind === "cores") {
      return { key, label, used: figure(usedValue), limit: figure(limitValue), unit: "cores", comparable: true };
    }
    // Both in the unit the limit reads best in
    const unit = bytesIn(limitValue).unit;
    const scale = 1024 ** BYTE_UNITS.indexOf(unit);
    return { key, label, used: figure(usedValue / scale), limit: figure(limitValue / scale), unit, comparable: true };
  });
}
