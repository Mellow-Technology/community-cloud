import { describe, expect, test } from "bun:test";

import { secretChanges, secretsSet, sharedValueUsers } from "./environment";

describe("what's written to the application's Secret", () => {
  test("is the values typed, and nothing for a kept one left blank", () => {
    expect(
      secretChanges(
        [
          { name: "STRIPE_KEY", value: "sk_new", secret: true },
          { name: "OLD_KEY", value: "", secret: true },
          { name: "LOG_LEVEL", value: "info" },
        ],
        ["OLD_KEY"],
      ),
    ).toEqual({ STRIPE_KEY: "sk_new" });
  });

  test("takes out what it no longer reads", () => {
    expect(secretChanges([{ name: "LOG_LEVEL", value: "info" }], ["STRIPE_KEY"])).toEqual({ STRIPE_KEY: null });
  });

  test("starts from what Cirrus says has a value", () => {
    expect(
      secretsSet({
        status: {
          environment: {
            secrets: [
              { name: "A", set: true },
              { name: "B", set: false },
            ],
          },
        },
      }),
    ).toEqual(new Set(["A"]));
  });
});

test("a shared value's users are the applications reading it", () => {
  const apps = [
    { metadata: { name: "shop" }, spec: { image: { repository: "shop" }, shared: [{ name: "K" }] } },
    { metadata: { name: "blog" }, spec: { image: { repository: "blog" }, env: [{ name: "K", value: "k" }] } },
  ];
  expect(sharedValueUsers(apps, "K")).toEqual(["shop"]);
});

describe("an environment Secret", () => {
  test("is made, changed key by key, and never someone else's", async () => {
    const { fixtureClient } = await import("./kube/fixtures");
    (globalThis as { __meteorologistFixtures?: unknown }).__meteorologistFixtures = undefined;
    const kube = fixtureClient();
    const labels = { "community-cloud.technology/environment": "application" };
    await kube.patchEnvironmentSecret("team-shop", "shop-secrets", { A: "1", B: "2" }, labels);
    await kube.patchEnvironmentSecret("team-shop", "shop-secrets", { A: null, C: "3" }, labels);
    expect(await kube.listSecretKeys("team-shop", "shop-secrets")).toEqual(["B", "C"]);
    // Made by hand, without the label
    await expect(kube.patchEnvironmentSecret("team-shop", "shop-gitlab-token", { A: "1" }, labels)).rejects.toThrow(
      "didn't make",
    );
  });
});
