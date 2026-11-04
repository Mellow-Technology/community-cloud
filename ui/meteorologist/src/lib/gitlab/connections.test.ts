import { describe, expect, test } from "bun:test";

import {
  CONNECTION_LABEL,
  URL_ANNOTATION,
  connectionProblem,
  connectionsIn,
  imageFor,
  normaliseUrl,
  suggestedName,
  tokenPages,
  type GitLabProject,
} from "./connections";

describe("connections", () => {
  test("are the Secrets marked as one, with their instance", () => {
    const connections = connectionsIn([
      { name: "registry", type: "kubernetes.io/dockerconfigjson" },
      { name: "plain", type: "Opaque", labels: { other: "true" } },
      {
        name: "work",
        type: "Opaque",
        labels: { [CONNECTION_LABEL]: "true" },
        annotations: { [URL_ANNOTATION]: "https://gitlab.example.test" },
      },
      { name: "gitlab-com", type: "Opaque", labels: { [CONNECTION_LABEL]: "true" } },
    ]);
    expect(connections).toEqual([
      { name: "gitlab-com", url: "https://gitlab.com", createdAt: undefined },
      { name: "work", url: "https://gitlab.example.test", createdAt: undefined },
    ]);
  });

  test("are named after their instance unless named otherwise", () => {
    expect(suggestedName("https://gitlab.com/")).toBe("gitlab-com");
    expect(suggestedName("https://code.example.test:8443")).toBe("gitlab-code-example-test-8443");
    expect(normaliseUrl("  ")).toBe("https://gitlab.com");
  });

  test("need a name, an address and a token", () => {
    expect(connectionProblem("work", "https://gitlab.com", "glpat-x")).toBeUndefined();
    expect(connectionProblem("Work!", "https://gitlab.com", "glpat-x")).toContain("Name");
    expect(connectionProblem("work", "https://gitlab.com/group", "glpat-x")).toContain("without a path");
    expect(connectionProblem("work", "https://gitlab.com", " ")).toContain("token");
  });

  test("link to where tokens are made", () => {
    expect(tokenPages("https://gitlab.example.test/")).toEqual({
      personal: "https://gitlab.example.test/-/user_settings/personal_access_tokens",
      groups: "https://gitlab.example.test/dashboard/groups",
    });
  });
});

describe("the image to run for a project", () => {
  const project: GitLabProject = {
    id: 1,
    path: "acme/shop",
    name: "Acme / shop",
    webUrl: "https://gitlab.com/acme/shop",
    registryPrefix: "registry.gitlab.com/acme/shop",
  };

  test("is the registry's only repository", () => {
    expect(imageFor(project, ["registry.gitlab.com/acme/shop/web"])).toBe("registry.gitlab.com/acme/shop/web");
  });

  test("is the one named for the project, among several", () => {
    expect(imageFor(project, ["registry.gitlab.com/acme/shop/worker", "registry.gitlab.com/acme/shop"])).toBe(
      "registry.gitlab.com/acme/shop",
    );
  });

  test("is left to be chosen among several, none named for the project", () => {
    expect(
      imageFor(project, ["registry.gitlab.com/acme/shop/web", "registry.gitlab.com/acme/shop/worker"]),
    ).toBeUndefined();
  });

  test("is where the first image would go, before there are any", () => {
    expect(imageFor(project, [])).toBe("registry.gitlab.com/acme/shop");
    expect(imageFor({ ...project, registryPrefix: undefined }, [])).toBeUndefined();
  });
});
