import { describe, expect, test } from "bun:test";

import { confirmsDeletion, deletionSummary } from "./deletion";
import type { WebApplication, WebApplicationSpec } from "./types";

/**
 * An application asking for these.
 *
 * @param spec
 * @returns
 */
function app(spec: Partial<WebApplicationSpec> = {}): WebApplication {
  return {
    apiVersion: "community-cloud.technology/v1alpha1",
    kind: "WebApplication",
    metadata: { name: "shop", namespace: "team" },
    spec: { image: { repository: "nginx" }, ...spec },
  };
}

describe("what deleting an application does", () => {
  test("stops it, and keeps nothing it didn't have", () => {
    expect(deletionSummary(app())).toEqual({
      removed: ["Its Deployment and Service, so it stops running."],
      kept: [],
    });
  });

  test("says which hostnames stop answering", () => {
    expect(deletionSummary(app({ hostnames: ["shop.example.org"] })).removed).toContain(
      "Its routes, so shop.example.org stops answering.",
    );
    expect(deletionSummary(app({ hostnames: ["shop.example.org", "www.example.org"] })).removed).toContain(
      "Its routes, so shop.example.org, www.example.org stop answering.",
    );
  });

  test("keeps the database and the bucket's contents", () => {
    const { kept } = deletionSummary(app({ postgres: {}, bucket: {} }));
    expect(kept).toHaveLength(2);
    expect(kept[0]).toContain("cirrus-postgres");
    expect(kept[1]).toBe("Its bucket, and everything in it.");
  });

  test("warns that RabbitMQ messages go with the vhost", () => {
    expect(deletionSummary(app({ rabbitmq: {} })).removed.join(" ")).toContain("messages still waiting");
  });

  test("names the GitLab project whose webhook is removed", () => {
    const summary = deletionSummary(
      app({ source: { gitlab: { project: "team/shop", tokenSecret: { name: "gitlab", key: "token" } } } }),
    );
    expect(summary.removed.join(" ")).toContain("team/shop");
  });
});

describe("confirming a delete", () => {
  test("takes exactly the name, spaces around it aside", () => {
    expect(confirmsDeletion("shop", "shop")).toBe(true);
    expect(confirmsDeletion("  shop ", "shop")).toBe(true);
  });

  test("refuses anything else", () => {
    expect(confirmsDeletion("", "shop")).toBe(false);
    expect(confirmsDeletion("Shop", "shop")).toBe(false);
    expect(confirmsDeletion("sho", "shop")).toBe(false);
    expect(confirmsDeletion("shop-2", "shop")).toBe(false);
  });
});
