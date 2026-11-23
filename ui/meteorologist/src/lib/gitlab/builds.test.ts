import { describe, expect, test } from "bun:test";
import { parse } from "yaml";

import {
  BUILDS_CONFIG_MAP,
  buildSettingsFrom,
  buildsConfigMap,
  ciFile,
  dockerfileFor,
  dockerfileProblem,
  includeSnippet,
  includeUrl,
  projectFromSegments,
  withProjectDockerfile,
} from "./builds";
import { keyMatches, newKey } from "./buildKeys";

describe("build settings", () => {
  test("read back what was written", () => {
    const settings = { key: "k", dockerfile: "ops/docker/Dockerfile", projects: { "group/app": "app/Dockerfile" } };
    const configMap = buildsConfigMap("team-shop", settings, { a: "b" });
    expect(configMap.metadata).toMatchObject({ name: BUILDS_CONFIG_MAP, namespace: "team-shop", labels: { a: "b" } });
    expect(buildSettingsFrom(configMap)).toEqual(settings);
  });

  test("are nothing without a key, and survive projects written badly by hand", () => {
    expect(buildSettingsFrom(undefined)).toBeUndefined();
    expect(buildSettingsFrom({ metadata: { name: BUILDS_CONFIG_MAP }, data: { dockerfile: "x" } })).toBeUndefined();
    expect(
      buildSettingsFrom({ metadata: { name: BUILDS_CONFIG_MAP }, data: { key: "k", projects: "not json" } }),
    ).toEqual({ key: "k", dockerfile: undefined, projects: {} });
  });

  test("keep the version they were read at, so a change since is refused", () => {
    const existing = { metadata: { name: BUILDS_CONFIG_MAP, resourceVersion: "7" }, data: {} };
    expect(buildsConfigMap("ns", { key: "k", projects: {} }, {}, existing).metadata.resourceVersion).toBe("7");
  });
});

describe("dockerfiles", () => {
  const settings = { key: "k", dockerfile: "ops/docker/Dockerfile", projects: { "group/app": "app/Dockerfile" } };

  test("a project's own, then the namespace's, then Dockerfile", () => {
    expect(dockerfileFor(settings, "Group/App")).toBe("app/Dockerfile");
    expect(dockerfileFor(settings, "group/other")).toBe("ops/docker/Dockerfile");
    expect(dockerfileFor(undefined, "group/other")).toBe("Dockerfile");
  });

  test("a project's path is dropped when blank or the same as the default", () => {
    expect(withProjectDockerfile(settings, "group/app", " ").projects).toEqual({});
    expect(withProjectDockerfile(settings, "group/app", "./ops/docker/Dockerfile").projects).toEqual({});
    expect(withProjectDockerfile(settings, "group/new", "./web/Dockerfile").projects).toEqual({
      "group/app": "app/Dockerfile",
      "group/new": "web/Dockerfile",
    });
  });

  test("only paths inside the repository, with nothing to quote", () => {
    expect(dockerfileProblem("")).toBeUndefined();
    expect(dockerfileProblem("ops/docker/Dockerfile.prod")).toBeUndefined();
    expect(dockerfileProblem("./Dockerfile")).toBeUndefined();
    for (const bad of ["/etc/passwd", "../Dockerfile", "a/../../b", 'x"; rm -rf /', "a b", "a//b"]) {
      expect(dockerfileProblem(bad)).toBeDefined();
    }
  });
});

describe("include URLs", () => {
  test("end in .yml, with the key in the path, and come back to the project", () => {
    const url = includeUrl("https://meteorologist.example", "team-shop", "abc_-1", "group/sub/app");
    expect(url).toBe("https://meteorologist.example/ci/gitlab/team-shop/abc_-1/group/sub/app.yml");
    const segments = new URL(url).pathname.split("/").slice(5);
    expect(projectFromSegments(segments)).toBe("group/sub/app");
    expect(includeSnippet(url)).toBe(`include:\n  - remote: "${url}"\n`);
  });

  test("only for a YAML file's name", () => {
    expect(projectFromSegments(["group", "app.yaml"])).toBe("group/app");
    expect(projectFromSegments(["group", "app"])).toBeUndefined();
    expect(projectFromSegments([])).toBeUndefined();
  });
});

describe("keys", () => {
  test("are long, URL-safe and differ", () => {
    const key = newKey();
    expect(key).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(newKey()).not.toBe(key);
  });

  test("match only themselves", () => {
    expect(keyMatches("abc", "abc")).toBe(true);
    expect(keyMatches("abd", "abc")).toBe(false);
    expect(keyMatches("ab", "abc")).toBe(false);
    expect(keyMatches("", "")).toBe(false);
  });
});

test("the CI file is YAML that builds from the Dockerfile given", () => {
  const parsed = parse(ciFile("ops/docker/Dockerfile")) as {
    "docker-build": { variables: Record<string, string>; script: string[] };
  };
  expect(parsed["docker-build"].variables.DOCKERFILE).toBe("ops/docker/Dockerfile");
  expect(parsed["docker-build"].script.join("\n")).toContain('--file "$DOCKERFILE"');
});
