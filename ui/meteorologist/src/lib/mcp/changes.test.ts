import { describe, expect, test } from "bun:test";

import { emptyForm, fromForm, toForm } from "../webapp/form";
import type { WebApplication } from "../webapp/types";
import { applyChanges } from "./changes";

const live: WebApplication = {
  apiVersion: "community-cloud.technology/v1alpha1",
  kind: "WebApplication",
  metadata: { name: "shop", namespace: "team-shop", resourceVersion: "7" },
  spec: {
    image: { repository: "registry.gitlab.com/acme/shop", tag: "main" },
    hostnames: ["shop.example.org"],
    postgres: {},
    bucket: { quota: "5Gi" },
    volumes: [{ name: "data", mountPath: "/data", size: "1Gi" }],
    env: [
      { name: "NODE_ENV", value: "production" },
      { name: "STRIPE_KEY", valueFrom: { secretKeyRef: { name: "shop-stripe", key: "key" } } },
    ],
  },
};

/**
 * The resource an update would write.
 *
 * @param changes
 * @returns
 */
function updated(changes: Parameters<typeof applyChanges>[1]) {
  const { form, problems } = applyChanges(toForm(live), changes);
  return { app: fromForm(form, live), problems };
}

describe("an update", () => {
  test("changes what it names and keeps everything else", () => {
    const { app, problems } = updated({ image: { repository: "registry.gitlab.com/acme/shop", tag: "v2" } });
    expect(problems).toEqual([]);
    expect(app.spec.image.tag).toBe("v2");
    expect(app.spec.hostnames).toEqual(["shop.example.org"]);
    expect(app.spec.env).toEqual(live.spec.env);
    expect(app.spec.bucket).toEqual({ quota: "5Gi" });
    expect(app.metadata.resourceVersion).toBe("7");
  });

  test("sets and removes plain variables", () => {
    const { app } = updated({ env: { NODE_ENV: null, LOG_LEVEL: "info" } });
    expect(app.spec.env).toEqual([
      { name: "LOG_LEVEL", value: "info" },
      { name: "STRIPE_KEY", valueFrom: { secretKeyRef: { name: "shop-stripe", key: "key" } } },
    ]);
  });

  test("won't touch a variable read from a Secret", () => {
    expect(updated({ env: { STRIPE_KEY: "sk_live_oops" } }).problems).toEqual([
      "STRIPE_KEY is read from a Secret or ConfigMap, so it can't be changed from here.",
    ]);
  });

  test("won't turn a service off", () => {
    expect(updated({ postgres: false, bucket: false }).problems).toHaveLength(2);
  });

  test("adds a volume, and won't change one that's there", () => {
    const { app } = updated({ volumes: [{ name: "cache", mountPath: "/cache", size: "2Gi", type: "ram" }] });
    expect(app.spec.volumes).toHaveLength(2);
    expect(updated({ volumes: [{ name: "data", mountPath: "/data", size: "50Gi" }] }).problems).toEqual([
      "The volume data is already there. A person changes it in Meteorologist.",
    ]);
    // The same as it is isn't a change
    expect(updated({ volumes: [{ name: "data", mountPath: "/data", size: "1Gi" }] }).problems).toEqual([]);
  });

  test("says what isn't valid in the agent's own names for the fields", () => {
    expect(updated({ healthCheckPath: "up", resources: { memoryLimit: "lots" } }).problems).toEqual([
      "healthCheckPath: A path, starting with /.",
      "resources.memoryLimit: A Kubernetes quantity, such as 250m, 512Mi or 10Gi.",
    ]);
  });
});

describe("a new application", () => {
  test("gets what was found in its project", () => {
    const { form, problems } = applyChanges(
      { ...emptyForm("sandbox"), name: "blog", imageSource: "other" },
      {
        image: { repository: "ghcr.io/acme/blog", tag: "1.0" },
        postgres: true,
        migrations: { command: ["bin/rails", "db:migrate"] },
        healthCheckPath: "/up",
        gitlab: { project: "acme/blog", connection: "acme-gitlab" },
      },
    );
    expect(problems).toEqual([]);
    const app = fromForm(form);
    expect(app.spec).toMatchObject({
      image: { repository: "ghcr.io/acme/blog", tag: "1.0" },
      postgres: {},
      migrations: { command: ["bin/rails", "db:migrate"] },
      healthCheck: { path: "/up" },
      source: { gitlab: { project: "acme/blog", tokenSecret: { name: "acme-gitlab" }, ref: "main" } },
    });
    expect(app.spec.hostnames).toBeUndefined();
  });
});
