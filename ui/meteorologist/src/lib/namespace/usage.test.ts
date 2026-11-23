import { describe, expect, test } from "bun:test";

import { quotaFigures } from "./usage";

describe("quota figures", () => {
  test("puts used and the limit in one unit", () => {
    const figures = quotaFigures({
      metadata: { name: "community-cloud" },
      status: {
        hard: { "requests.cpu": "4", "limits.memory": "8Gi", "requests.storage": "50Gi" },
        used: { "requests.cpu": "1500m", "limits.memory": "256Mi" },
      },
    });
    expect(figures).toEqual([
      { key: "requests.cpu", label: "CPU reserved", used: "1.5", limit: "4", unit: "cores", comparable: true },
      { key: "limits.memory", label: "Memory", used: "0.25", limit: "8", unit: "GiB", comparable: true },
      { key: "requests.storage", label: "Storage", used: "0", limit: "50", unit: "GiB", comparable: true },
    ]);
  });

  test("leaves out limits that aren't set, and shows what it can't read as written", () => {
    const figures = quotaFigures({
      metadata: { name: "community-cloud" },
      status: { hard: { "requests.cpu": "lots" }, used: { "requests.cpu": "1" } },
    });
    expect(figures).toEqual([
      { key: "requests.cpu", label: "CPU reserved", used: "1", limit: "lots", comparable: false },
    ]);
    expect(quotaFigures(undefined)).toEqual([]);
  });
});
