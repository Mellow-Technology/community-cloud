import { describe, expect, test } from "bun:test";

import { forgeStatus } from "./forge";
import type { WebApplication } from "./types";
import type { Condition } from "../kube/types";

/**
 * An application from GitLab, with these conditions.
 *
 * @param conditions
 * @returns
 */
function app(conditions: Array<[string, boolean, string, string?]>) {
  return {
    apiVersion: "community-cloud.technology/v1alpha1",
    kind: "WebApplication",
    metadata: { name: "shop", namespace: "team" },
    spec: {
      image: { repository: "registry.gitlab.com/acme/shop" },
      source: { gitlab: { project: "acme/shop", tokenSecret: { name: "gitlab" } } },
    },
    status: {
      conditions: conditions.map(([type, ok, reason, message]): Condition => ({
        type,
        status: ok ? "True" : "False",
        reason,
        message,
      })),
    },
  } satisfies WebApplication;
}

describe("forge status", () => {
  test("is nothing for an application with no forge", () => {
    const plain = app([]);
    expect(forgeStatus({ ...plain, spec: { image: plain.spec.image } })).toBeUndefined();
  });

  test("is pending until Cirrus reports on it", () => {
    expect(forgeStatus(app([["Ready", true, "Ready"]]))?.state).toBe("pending");
  });

  test("is connected when the webhook is registered and the check worked", () => {
    expect(
      forgeStatus(
        app([
          ["WebhookRegistered", true, "Registered"],
          ["ReleaseChecked", true, "Checked"],
        ]),
      ),
    ).toEqual({ state: "connected", tone: "success", label: "Connected" });
  });

  test("is polling only without a webhook", () => {
    expect(
      forgeStatus(
        app([
          ["WebhookRegistered", false, "NotRegistered", "the token needs the Maintainer role"],
          ["ReleaseChecked", true, "Checked"],
        ]),
      ),
    ).toMatchObject({ state: "polling", message: "the token needs the Maintainer role" });
  });

  test("says when a pipeline published no image, and the webhook too", () => {
    expect(
      forgeStatus(
        app([
          ["WebhookRegistered", false, "NotRegistered", "No webhook."],
          ["ReleaseChecked", false, "NoImage", "No image."],
        ]),
      ),
    ).toMatchObject({ state: "no-image", tone: "warning", message: "No image. No webhook." });
  });

  test("is failing when GitLab couldn't be asked", () => {
    expect(forgeStatus(app([["ReleaseChecked", false, "CheckFailed", "401"]]))).toMatchObject({
      state: "failing",
      tone: "danger",
      message: "401",
    });
  });
});
