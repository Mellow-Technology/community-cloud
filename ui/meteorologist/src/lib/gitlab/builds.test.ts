import { describe, expect, test } from "bun:test";
import { parse } from "yaml";

import {
  BUILDS_CONFIG_MAP,
  buildFor,
  buildProblems,
  buildSettingsFrom,
  buildsConfigMap,
  ciFile,
  describeBuild,
  includeSnippet,
  includeUrl,
  projectFromSegments,
  withProjectBuild,
  type BuildSettings,
} from "./builds";
import { keyMatches, newKey } from "./buildKeys";

describe("build settings", () => {
  test("read back what was written", () => {
    const settings: BuildSettings = {
      key: "k",
      build: { dockerfile: "ops/docker/Dockerfile", bakeTarget: "web" },
      projects: {
        "group/app": { dockerfile: "app/Dockerfile" },
        "group/baked": { bakeFile: "ci/docker-bake.hcl", bakeTarget: "api" },
      },
    };
    const configMap = buildsConfigMap("team-shop", settings, { a: "b" });
    expect(configMap.metadata).toMatchObject({ name: BUILDS_CONFIG_MAP, namespace: "team-shop", labels: { a: "b" } });
    expect(configMap.data).toMatchObject({ dockerfile: "ops/docker/Dockerfile", bakeTarget: "web" });
    expect(buildSettingsFrom(configMap)).toEqual(settings);
  });

  test("read what was written before bake: a Dockerfile default, and paths by project", () => {
    expect(
      buildSettingsFrom({
        metadata: { name: BUILDS_CONFIG_MAP },
        data: { key: "k", dockerfile: "ops/Dockerfile", projects: '{ "Group/App": "app/Dockerfile" }' },
      }),
    ).toEqual({
      key: "k",
      build: { dockerfile: "ops/Dockerfile" },
      projects: { "group/app": { dockerfile: "app/Dockerfile" } },
    });
  });

  test("are nothing without a key, and survive projects written badly by hand", () => {
    expect(buildSettingsFrom(undefined)).toBeUndefined();
    expect(buildSettingsFrom({ metadata: { name: BUILDS_CONFIG_MAP }, data: { dockerfile: "x" } })).toBeUndefined();
    expect(
      buildSettingsFrom({ metadata: { name: BUILDS_CONFIG_MAP }, data: { key: "k", projects: "not json" } }),
    ).toEqual({ key: "k", build: {}, projects: {} });
    expect(
      buildSettingsFrom({
        metadata: { name: BUILDS_CONFIG_MAP },
        data: { key: "k", projects: '{"a/b": 3, "c/d": {}}' },
      })?.projects,
    ).toEqual({});
  });

  test("keep the version they were read at, so a change since is refused", () => {
    const existing = { metadata: { name: BUILDS_CONFIG_MAP, resourceVersion: "7" }, data: {} };
    expect(buildsConfigMap("ns", { key: "k", build: {}, projects: {} }, {}, existing).metadata.resourceVersion).toBe(
      "7",
    );
  });
});

describe("builds", () => {
  const settings: BuildSettings = {
    key: "k",
    build: { dockerfile: "ops/docker/Dockerfile", bakeTarget: "web" },
    projects: { "group/app": { bakeTarget: "api" } },
  };

  test("a project's own, then the namespace's, field by field", () => {
    expect(buildFor(settings, "Group/App")).toEqual({ dockerfile: "ops/docker/Dockerfile", bakeTarget: "api" });
    expect(buildFor(settings, "group/other")).toEqual(settings.build);
    expect(buildFor(undefined, "group/other")).toEqual({});
  });

  test("a project keeps only what differs from the namespace's, and nothing when nothing does", () => {
    expect(withProjectBuild(settings, "group/app", {}).projects).toEqual({});
    expect(
      withProjectBuild(settings, "group/app", { dockerfile: "./ops/docker/Dockerfile", bakeTarget: "web" }).projects,
    ).toEqual({});
    expect(
      withProjectBuild(settings, "group/new", { dockerfile: "./web/Dockerfile", bakeTarget: "web" }).projects,
    ).toEqual({ "group/app": { bakeTarget: "api" }, "group/new": { dockerfile: "web/Dockerfile" } });
    // The defaults count as the namespace's when it has none
    expect(
      withProjectBuild({ key: "k", build: {}, projects: {} }, "a/b", { dockerfile: "Dockerfile" }).projects,
    ).toEqual({});
  });

  test("only paths inside the repository and targets' names, with nothing to quote", () => {
    expect(buildProblems({})).toEqual({});
    expect(
      buildProblems({ dockerfile: "./ops/Dockerfile.prod", bakeFile: "ci/docker-bake.hcl", bakeTarget: "web_app-1" }),
    ).toEqual({});
    for (const bad of ["/etc/passwd", "../Dockerfile", "a/../../b", 'x"; rm -rf /', "a b", "a//b"]) {
      expect(buildProblems({ dockerfile: bad }).dockerfile).toBeDefined();
      expect(buildProblems({ bakeFile: bad }).bakeFile).toBeDefined();
    }
    expect(buildProblems({ bakeTarget: "web app" }).bakeTarget).toBeDefined();
    expect(buildProblems({ bakeTarget: "*" }).bakeTarget).toBeDefined();
  });

  test("described in a few words", () => {
    expect(describeBuild({ dockerfile: "app/Dockerfile" })).toBe("Dockerfile app/Dockerfile");
    expect(describeBuild({ bakeFile: "ci/bake.hcl", bakeTarget: "web" })).toBe(
      "bake file ci/bake.hcl, bake target web",
    );
  });
});

describe("include URLs", () => {
  test("end in .yml, with the key in the path, and come back to the project", () => {
    const url = includeUrl("https://meteorologist.example", "dockerfile", "team-shop", "abc_-1", "group/sub/app");
    expect(url).toBe("https://meteorologist.example/ci/gitlab/team-shop/abc_-1/group/sub/app.yml");
    expect(includeUrl("https://meteorologist.example", "bake", "team-shop", "abc_-1", "group/sub/app")).toBe(
      "https://meteorologist.example/ci/gitlab-bake/team-shop/abc_-1/group/sub/app.yml",
    );
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

describe("the CI file", () => {
  interface Job {
    variables: Record<string, string>;
    script: string[];
  }
  const job = (text: string) => (parse(text) as { "docker-build": Job })["docker-build"];

  test("builds from the Dockerfile given", () => {
    const build = job(ciFile("dockerfile", { dockerfile: "ops/docker/Dockerfile", bakeTarget: "web" }));
    expect(build.variables.DOCKERFILE).toBe("ops/docker/Dockerfile");
    expect(build.script.join("\n")).toContain('--file "$DOCKERFILE"');
  });

  test("bakes the target given, tagged and pushed as Cirrus expects", () => {
    const build = job(
      ciFile("bake", { dockerfile: "x/Dockerfile", bakeFile: "ci/docker-bake.hcl", bakeTarget: "web" }),
    );
    expect(build.variables).toMatchObject({
      BAKE_FILE: "ci/docker-bake.hcl",
      BAKE_TARGET: "web",
      BAKE_MAIN_TARGET: "",
    });
    const script = build.script.join("\n");
    expect(script).toContain("docker buildx bake $files --print");
    expect(script).toContain('--set "$each.tags=$repository:$CI_COMMIT_SHORT_SHA"');
    expect(script.trim().endsWith('docker buildx bake $files "$@" --push "$BAKE_TARGET"')).toBe(true);
  });

  test("names the main target, when there is one", () => {
    expect(job(ciFile("bake", { bakeTarget: "all", bakeMainTarget: "web" })).variables).toMatchObject({
      BAKE_MAIN_TARGET: "web",
    });
  });

  test("leaves the bake file to bake when none is given", () => {
    expect(job(ciFile("bake", {})).variables).toMatchObject({ BAKE_FILE: "", BAKE_TARGET: "default" });
  });
});

// What the bake job's script pushes where, run with a stand-in for
// docker that answers --print with the given targets and records what
// the build was asked to do. Needs sh and jq, as the job's image has.
const hasTools = Bun.spawnSync(["sh", "-c", "command -v jq"]).exitCode === 0;

/**
 * The tags each target is pushed with.
 *
 * @param targets what the bake target resolves to
 * @param main BAKE_MAIN_TARGET
 * @returns by target
 */
function pushed(targets: string[], main = ""): Record<string, string[]> {
  const file = parse(ciFile("bake", { bakeTarget: "all", bakeMainTarget: main })) as {
    "docker-build": { script: string[] };
  };
  const shell = file["docker-build"].script.at(-1) ?? "";
  const directory = `${process.env.TMPDIR ?? "/tmp"}/bake-test-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const plan = JSON.stringify({ target: Object.fromEntries(targets.map((each) => [each, {}])) });
  const docker = `#!/bin/sh\ncase "$*" in *--print*) echo '${plan}' ;; *) printf '%s\\n' "$@" > "$OUT" ;; esac\n`;
  Bun.spawnSync(["mkdir", "-p", directory]);
  Bun.spawnSync(["sh", "-c", `cat > "${directory}/docker" && chmod +x "${directory}/docker"`], {
    stdin: Buffer.from(docker),
  });
  const run = Bun.spawnSync(["sh", "-c", shell], {
    env: {
      PATH: `${directory}:${process.env.PATH}`,
      OUT: `${directory}/out`,
      CI_REGISTRY_IMAGE: "registry.gitlab.com/acme/shop",
      CI_COMMIT_SHORT_SHA: "abc123",
      BAKE_FILE: "",
      BAKE_TARGET: "all",
      BAKE_MAIN_TARGET: main,
    },
  });
  const args =
    run.exitCode === 0
      ? Bun.spawnSync(["cat", `${directory}/out`])
          .stdout.toString()
          .split("\n")
      : [];
  Bun.spawnSync(["rm", "-rf", directory]);
  const tags: Record<string, string[]> = {};
  for (const arg of args) {
    const match = arg.match(/^([^.]+)\.tags=(.+)$/);
    if (match) (tags[match[1]!] ??= []).push(match[2]!);
  }
  return tags;
}

describe.if(hasTools)("what the bake job pushes", () => {
  test("one target goes to the project's own repository, as before", () => {
    expect(pushed(["default"])).toEqual({
      default: ["registry.gitlab.com/acme/shop:abc123", "registry.gitlab.com/acme/shop:latest"],
    });
  });

  test("a group's targets each go to a repository of their own", () => {
    const tags = pushed(["web", "api"]);
    expect(tags.api).toEqual(["registry.gitlab.com/acme/shop/api:abc123", "registry.gitlab.com/acme/shop/api:latest"]);
    expect(tags.web?.[0]).toBe("registry.gitlab.com/acme/shop/web:abc123");
  });

  test("the main target stays in the project's own repository", () => {
    const tags = pushed(["web", "api"], "web");
    expect(tags.web?.[0]).toBe("registry.gitlab.com/acme/shop:abc123");
    expect(tags.api?.[0]).toBe("registry.gitlab.com/acme/shop/api:abc123");
  });

  test("a repository's name is the target's, in lower case", () => {
    expect(pushed(["web", "Worker_2"]).Worker_2?.[0]).toBe("registry.gitlab.com/acme/shop/worker_2:abc123");
  });
});
