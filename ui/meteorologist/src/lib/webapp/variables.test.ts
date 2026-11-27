import { describe, expect, test } from "bun:test";

import type { WebApplication } from "./types";
import { givenVariables } from "./variables";

const app = (spec: Partial<WebApplication["spec"]>, status?: WebApplication["status"]): WebApplication => ({
  apiVersion: "community-cloud.technology/v1alpha1",
  kind: "WebApplication",
  metadata: { name: "app-a", namespace: "namespace-example" },
  spec: { image: { repository: "registry.example/app-a" }, ...spec },
  ...(status ? { status } : {}),
});

describe("an application's variables", () => {
  test("are Cirrus's report, when there is one", () => {
    const reported = [{ name: "S3_PUBLIC_ENDPOINT", from: "bucket", value: "https://storage.example" }];
    expect(givenVariables(app({ bucket: {} }, { variables: reported }))).toEqual({
      reported: true,
      variables: reported,
    });
  });

  test("are what the spec leads to until then, a Secret's by name", () => {
    const { reported, variables } = givenVariables(
      app({
        bucket: {},
        connections: [{ offering: "service-a", name: "search-api" }],
        secrets: [{ name: "API_TOKEN" }],
        shared: [{ name: "SMTP_HOST", as: "MAIL_HOST" }],
        env: [{ name: "LOG_LEVEL", value: "info" }],
      }),
    );
    expect(reported).toBe(false);
    const names = variables.map((each) => `${each.from}:${each.name}${each.secret ? "*" : ""}`);
    expect(names).toContain("bucket:S3_BUCKET");
    expect(names).toContain("bucket:S3_SECRET_ACCESS_KEY*");
    expect(names).toContain("connections:SEARCH_API_URL");
    expect(names).toContain("secrets:API_TOKEN*");
    expect(names).toContain("shared:MAIL_HOST");
    expect(variables.find((each) => each.name === "LOG_LEVEL")?.value).toBe("info");
    // Only Cirrus knows whether the cluster serves S3 outside
    expect(names.some((name) => name.includes("S3_PUBLIC_ENDPOINT"))).toBe(false);
  });
});
