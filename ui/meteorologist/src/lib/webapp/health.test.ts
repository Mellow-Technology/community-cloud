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

  test("is deleting once deletion is asked for, whatever it said before", () => {
    const ready = app([["Ready", true, "Ready"]]);
    const leaving: WebApplication = {
      ...ready,
      metadata: { ...ready.metadata, deletionTimestamp: "2026-11-03T00:00:00Z" },
    };
    expect(appHealth(leaving).state).toBe("deleting");
  });

  test("is pending while Cirrus is behind the spec", () => {
    expect(appHealth(app([["Ready", true, "Ready"]], [2, 1])).state).toBe("pending");
  });

  test("is healthy when ready", () => {
    expect(appHealth(app([["Ready", true, "Ready"]]))).toEqual({ state: "healthy", tone: "success", label: "Healthy" });
  });

  // Those are its forge status, in ./forge.ts
  test("is healthy when ready, whatever the webhook and the release check say", () => {
    const health = appHealth(
      app([
        ["Ready", true, "Ready"],
        ["WebhookRegistered", false, "NotRegistered", "401 from GitLab"],
        ["ReleaseChecked", false, "CheckFailed", "404 from GitLab"],
      ]),
    );
    expect(health).toEqual({ state: "healthy", tone: "success", label: "Healthy" });
  });

  test("is failing when no pod is serving, even if Cirrus finished rolling out", () => {
    expect(
      appHealth(
        app([
          ["Ready", true, "Ready"],
          ["Healthy", false, "PodsFailing", "0 of 1 pods ready. shop-1: ImagePullBackOff"],
        ]),
      ),
    ).toMatchObject({ state: "failing", tone: "danger", message: "0 of 1 pods ready. shop-1: ImagePullBackOff" });
  });

  test("is degraded when a pod is stuck but something serves", () => {
    expect(
      appHealth(
        app([
          ["Ready", true, "Ready"],
          ["Healthy", false, "PodsDegraded", "1 of 2 pods ready. shop-2: CrashLoopBackOff"],
        ]),
      ),
    ).toMatchObject({ state: "degraded", tone: "warning" });
  });

  test("says a new image is crash looping while the old pods serve mid-rollout", () => {
    expect(
      appHealth(
        app([
          ["Provisioned", true, "Provisioned"],
          ["RolledOut", false, "Progressing", "rolling out shop:2"],
          ["Healthy", false, "PodsDegraded", "shop-new: CrashLoopBackOff"],
          ["Ready", false, "NotReady"],
        ]),
      ),
    ).toMatchObject({ state: "degraded", message: "shop-new: CrashLoopBackOff" });
  });

  test("is progressing while pods start, and healthy once they have", () => {
    expect(
      appHealth(
        app([
          ["Provisioned", true, "Provisioned"],
          ["RolledOut", true, "RolledOut"],
          ["Healthy", false, "PodsStarting", "1 of 2 pods ready"],
          ["Ready", true, "Ready"],
        ]),
      ),
    ).toMatchObject({ state: "progressing", message: "1 of 2 pods ready" });
    expect(
      appHealth(
        app([
          ["Healthy", true, "PodsReady"],
          ["Ready", true, "Ready"],
        ]),
      ).state,
    ).toBe("healthy");
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
    expect(counts).toEqual({ healthy: 1, degraded: 0, progressing: 0, failing: 1, pending: 0, deleting: 0 });
  });
});
