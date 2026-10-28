import { describe, expect, test } from "bun:test";

import { appHealth, countHealth } from "./health";
import type { WebApplication } from "./types";
import type { Condition } from "../kube/types";

/**
 * An application with these conditions.
 *
 * @param conditions
 * @param generations the resource's generation, and the one Cirrus last saw
 * @returns
 */
function app(conditions: Array<[string, boolean, string, string?]>, generations: [number, number] = [1, 1]) {
  return {
    apiVersion: "community-cloud.technology/v1alpha1",
    kind: "WebApplication",
    metadata: { name: "shop", namespace: "team", generation: generations[0] },
    spec: { image: { repository: "nginx" } },
    status: {
      observedGeneration: generations[1],
      conditions: conditions.map(([type, ok, reason, message]): Condition => ({
        type,
        status: ok ? "True" : "False",
        reason,
        message,
      })),
    },
  } satisfies WebApplication;
}

describe("application health", () => {
  test("is pending until Cirrus reports", () => {
    expect(appHealth({ ...app([]), status: undefined }).state).toBe("pending");
  });

  test("is pending while Cirrus is behind the spec", () => {
    expect(appHealth(app([["Ready", true, "Ready"]], [2, 1])).state).toBe("pending");
  });

  test("is healthy when ready", () => {
    expect(appHealth(app([["Ready", true, "Ready"]]))).toEqual({ state: "healthy", tone: "success", label: "Healthy" });
  });

  test("is degraded when ready but the webhook isn't", () => {
    const health = appHealth(
      app([
        ["Ready", true, "Ready"],
        ["WebhookRegistered", false, "NotRegistered", "401 from GitLab"],
      ]),
    );
    expect(health).toMatchObject({ state: "degraded", message: "401 from GitLab" });
  });

  test("is degraded when ready but GitLab couldn't be asked for the newest release", () => {
    const health = appHealth(
      app([
        ["Ready", true, "Ready"],
        ["WebhookRegistered", true, "Registered"],
        ["ReleaseChecked", false, "CheckFailed", "404 from GitLab"],
      ]),
    );
    expect(health).toMatchObject({ state: "degraded", message: "404 from GitLab" });
  });

  test("is failing when blocked", () => {
    const health = appHealth(
      app([
        ["Provisioned", false, "Blocked", "no buckets here"],
        ["RolledOut", false, "WaitingForDependencies"],
        ["Ready", false, "NotReady"],
      ]),
    );
    expect(health).toMatchObject({ state: "failing", tone: "danger", message: "no buckets here" });
  });

  test("is failing when migrations failed", () => {
    expect(
      appHealth(
        app([
          ["Provisioned", true, "Provisioned"],
          ["RolledOut", false, "MigrationFailed", "job failed"],
          ["Ready", false, "NotReady"],
        ]),
      ).state,
    ).toBe("failing");
  });

  test("is progressing while waiting or rolling out", () => {
    expect(appHealth(app([["Provisioned", false, "Waiting", "database"]])).state).toBe("progressing");
    expect(
      appHealth(
        app([
          ["Provisioned", true, "Provisioned"],
          ["RolledOut", false, "Migrating", "running job"],
        ]),
      ),
    ).toMatchObject({ state: "progressing", message: "running job" });
  });

  test("counts by state", () => {
    const counts = countHealth([app([["Ready", true, "Ready"]]), app([["Provisioned", false, "Blocked"]])]);
    expect(counts).toEqual({ healthy: 1, degraded: 0, progressing: 0, failing: 1, pending: 0 });
  });
});
