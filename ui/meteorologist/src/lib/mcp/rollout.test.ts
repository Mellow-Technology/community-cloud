import { describe, expect, test } from "bun:test";

import type { KubeClient } from "../kube/client";
import type { Condition } from "../kube/types";
import type { WebApplication } from "../webapp/types";
import { rolloutState, waitForRollout } from "./rollout";

/**
 * A condition, as Cirrus sets it.
 *
 * @param type
 * @param status
 * @param reason
 * @param message
 * @returns
 */
function condition(type: string, status: "True" | "False", reason = "", message = ""): Condition {
  return { type, status, reason, message, lastTransitionTime: "2026-11-26T00:00:00Z" };
}

/**
 * An application at a generation, with what Cirrus last said.
 *
 * @param observedGeneration
 * @param conditions
 * @returns
 */
function app(observedGeneration: number, conditions: Condition[]): WebApplication {
  return {
    apiVersion: "community-cloud.technology/v1alpha1",
    kind: "WebApplication",
    metadata: { name: "blog", namespace: "sandbox", generation: 2 },
    spec: { image: { repository: "ghcr.io/acme/blog" } },
    status: { observedGeneration, conditions, migrationJob: "blog-migrate-abc" },
  };
}

const healthy = app(2, [condition("Ready", "True"), condition("Healthy", "True")]);
const migrating = app(2, [
  condition("Ready", "False"),
  condition("Provisioned", "True"),
  condition("RolledOut", "False", "Migrating", "running blog-migrate-abc"),
]);
const failed = app(2, [condition("Ready", "False"), condition("RolledOut", "False", "MigrationFailed", "exit 1")]);
const old = app(1, [condition("Ready", "True"), condition("Healthy", "True")]);

describe("where a rollout has got to", () => {
  test("isn't done while Cirrus is behind, however healthy it was", () => {
    expect(rolloutState(old, 2)).toMatchObject({ finished: false, health: { state: "pending" } });
  });

  test("is done and well once healthy at the change", () => {
    expect(rolloutState(healthy, 2)).toMatchObject({ finished: true, ok: true });
  });

  test("is done and not well when a migration failed", () => {
    expect(rolloutState(failed, 2)).toMatchObject({ finished: true, ok: false, health: { state: "failing" } });
  });

  test("is still going while migrating", () => {
    expect(rolloutState(migrating, 2)).toMatchObject({ finished: false });
  });
});

/**
 * A client that hands out the applications given, one per read, and
 * whose watch the test drives.
 *
 * @param states
 * @returns
 */
function scripted(states: WebApplication[]) {
  let read = 0;
  let changed: (() => void) | undefined;
  let stopped = false;
  const kube: Pick<KubeClient, "getWebApplication" | "watchWebApplications"> = {
    getWebApplication: async () => states[Math.min(read++, states.length - 1)]!,
    watchWebApplications: async (_scope, onChange) => {
      changed = onChange;
      return () => {
        stopped = true;
      };
    },
  };
  return { kube, change: () => changed?.(), isStopped: () => stopped };
}

describe("waiting", () => {
  test("says each new step, and ends when it's healthy", async () => {
    const { kube, change, isStopped } = scripted([old, migrating, migrating, healthy]);
    const said: string[] = [];
    const waiting = waitForRollout(kube, "sandbox", "blog", {
      generation: 2,
      timeoutSeconds: 5,
      onProgress: (text) => said.push(text),
    });
    for (let i = 0; i < 3; i += 1) {
      await Bun.sleep(1);
      change();
    }
    const outcome = await waiting;
    expect(outcome).toMatchObject({ finished: true, ok: true, timedOut: false });
    expect(said).toEqual([
      "Pending: Cirrus hasn't caught up with the latest change yet.",
      "Progressing: running blog-migrate-abc",
      "Healthy",
    ]);
    expect(isStopped()).toBe(true);
  });

  test("ends when it fails", async () => {
    const { kube, change } = scripted([migrating, failed]);
    const waiting = waitForRollout(kube, "sandbox", "blog", { generation: 2, timeoutSeconds: 5 });
    await Bun.sleep(1);
    change();
    expect(await waiting).toMatchObject({ finished: true, ok: false, timedOut: false });
  });

  test("gives what it last saw when the time runs out", async () => {
    const { kube } = scripted([migrating]);
    const outcome = await waitForRollout(kube, "sandbox", "blog", { generation: 2, timeoutSeconds: 1 });
    expect(outcome).toMatchObject({ finished: false, timedOut: true });
  });

  test("stops when the client goes away", async () => {
    const { kube } = scripted([migrating]);
    const leaving = new AbortController();
    const waiting = waitForRollout(kube, "sandbox", "blog", {
      generation: 2,
      timeoutSeconds: 60,
      signal: leaving.signal,
    });
    await Bun.sleep(1);
    leaving.abort();
    expect(await waiting).toMatchObject({ timedOut: true });
  });
});
