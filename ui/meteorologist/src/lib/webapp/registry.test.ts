import { describe, expect, test } from "bun:test";

import { normaliseRegistry, pullSecretsFor, registriesIn, registryOf } from "./registry";

describe("an image's registry", () => {
  test("is its first part, when that's a host", () => {
    expect(registryOf("registry.gitlab.com/acme/shop")).toBe("registry.gitlab.com");
    expect(registryOf("Registry.GitLab.com/acme/shop:main")).toBe("registry.gitlab.com");
    expect(registryOf("localhost:5000/shop")).toBe("localhost:5000");
    expect(registryOf("localhost/shop")).toBe("localhost");
  });

  test("is Docker Hub otherwise", () => {
    expect(registryOf("nginx")).toBe("docker.io");
    expect(registryOf("bitnami/redis")).toBe("docker.io");
    expect(registryOf("docker.io/library/nginx")).toBe("docker.io");
    expect(registryOf("index.docker.io/library/nginx")).toBe("docker.io");
  });

  test("is nothing yet, without an image", () => {
    expect(registryOf("  ")).toBeUndefined();
  });
});

test("credentials' registries are read the same way, whatever they were written as", () => {
  expect(normaliseRegistry("https://registry.gitlab.com/")).toBe("registry.gitlab.com");
  expect(normaliseRegistry("https://index.docker.io/v1/")).toBe("docker.io");
  expect(
    registriesIn(JSON.stringify({ auths: { "https://registry.gitlab.com": {}, "ghcr.io": {}, "GHCR.io/": {} } })),
  ).toEqual(["registry.gitlab.com", "ghcr.io"]);
  expect(registriesIn("not json")).toEqual([]);
  expect(registriesIn(undefined)).toEqual([]);
});

test("an image gets the namespace's credentials for its registry, and only those", () => {
  const secrets = [
    { name: "pull-registry-gitlab-com", registries: ["registry.gitlab.com"] },
    { name: "pull-ghcr-io", registries: ["ghcr.io"] },
    { name: "everything", registries: ["ghcr.io", "registry.gitlab.com"] },
  ];
  expect(pullSecretsFor("registry.gitlab.com/acme/shop", secrets)).toEqual(["pull-registry-gitlab-com", "everything"]);
  expect(pullSecretsFor("nginx", secrets)).toEqual([]);
  expect(pullSecretsFor("", secrets)).toEqual([]);
});
