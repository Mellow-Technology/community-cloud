/**
 * @file
 * Building images on GitLab CI from a file Meteorologist serves.
 *
 * A project's .gitlab-ci.yml includes one line, a remote include of a
 * URL here, and GitLab fetches the build from it each time a pipeline
 * starts. The build is much the same for everything: Docker in
 * Docker, tagging the image with the commit's short SHA, which is one of
 * the tags Cirrus looks for, and pushing it to the project's registry.
 *
 * There are two, side by side, at different paths: one that runs docker
 * build with a Dockerfile, and one that runs buildx bake with a target
 * from a bake file. A project uses whichever it includes. What's set is
 * where those are: for the namespace, and for any project whose are
 * somewhere else.
 *
 * GitLab fetches the file without signing in, so the URL carries a key
 * that only the namespace's settings know. The settings are a
 * ConfigMap in the namespace with one fixed name, which Meteorologist's
 * own account may read and nothing else of: the file is served without
 * anyone signed in to read it as. It holds paths, targets and the key,
 * nothing a token could get at.
 *
 * The key is in the path rather than a query parameter because GitLab
 * only includes a remote file whose name ends in .yml or .yaml, and it
 * takes the name to be everything after the last slash, query and all.
 */
import type { ConfigMap } from "../kube/types";

// The namespace's build settings. Meteorologist's own account can get a
// ConfigMap by this name in any namespace, and no other.
export const BUILDS_CONFIG_MAP = "meteorologist-gitlab-builds";

// Where the Dockerfile is when nothing says otherwise: GitLab's and
// Docker's own default
export const DEFAULT_DOCKERFILE = "Dockerfile";

// What bake builds when no target is named
export const DEFAULT_BAKE_TARGET = "default";

/**
 * The two builds, each served at a path of its own: docker build, and
 * buildx bake.
 */
export type Builder = "dockerfile" | "bake";

// Where each is served, under Meteorologist's address. The Dockerfile's
// is the one from before bake, so includes made then keep working.
const BUILDER_PATHS: Record<Builder, string> = { dockerfile: "ci/gitlab", bake: "ci/gitlab-bake" };

/**
 * Where a project's builds find what they build from. Blank is the
 * default: Dockerfile, bake's own search for its file, and the
 * "default" target.
 *
 * A bake target can be a group of several, each its own image: each
 * is pushed to a repository of its own under the project's,
 * <project>/<target>. bakeMainTarget is the one pushed to the
 * project's own repository instead, for a project whose main image was
 * there before it built others beside it. Blank, a build of one target
 * is pushed there, as it always was, and a group's all go under it.
 */
export interface Build {
  dockerfile?: string;
  bakeFile?: string;
  bakeTarget?: string;
  bakeMainTarget?: string;
}

const BUILD_FIELDS = ["dockerfile", "bakeFile", "bakeTarget", "bakeMainTarget"] as const;
// The fields that are names rather than paths
const NAME_FIELDS: ReadonlySet<string> = new Set(["bakeTarget", "bakeMainTarget"]);

/**
 * A namespace's build settings.
 *
 * - key: what the include URLs have to carry
 * - build: where its projects' builds find things
 * - projects: by project path, lower-cased, whatever a project has
 *   somewhere else; anything it leaves out is the namespace's
 *
 * In the ConfigMap the namespace's are the keys dockerfile, bakeFile
 * and bakeTarget, and projects is a JSON object. A project's entry
 * there may be a string, which is a Dockerfile path: how they were all
 * written before bake.
 */
export interface BuildSettings {
  key: string;
  build: Build;
  projects: Record<string, Build>;
}

/**
 * A path as kept: trimmed, without a leading "./".
 *
 * @param path
 * @returns
 */
export function normalisePath(path: string): string {
  return path.trim().replace(/^(\.\/)+/, "");
}

/**
 * A build with its fields trimmed and blanks left out.
 *
 * @param build
 * @returns
 */
export function normaliseBuild(build: Build | undefined): Build {
  const normalised: Build = {};
  for (const field of BUILD_FIELDS) {
    const value = build?.[field];
    const trimmed = value === undefined ? "" : NAME_FIELDS.has(field) ? value.trim() : normalisePath(value);
    if (trimmed !== "") {
      normalised[field] = trimmed;
    }
  }
  return normalised;
}

/**
 * A project's entry as stored, or nothing when it's unreadable or
 * empty.
 *
 * @param value
 * @returns
 */
function storedBuild(value: unknown): Build | undefined {
  let build: Build;
  if (typeof value === "string") {
    build = normaliseBuild({ dockerfile: value });
  } else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const entry = value as Record<string, unknown>;
    const text = (field: string) => (typeof entry[field] === "string" ? entry[field] : undefined);
    build = normaliseBuild({
      dockerfile: text("dockerfile"),
      bakeFile: text("bakeFile"),
      bakeTarget: text("bakeTarget"),
      bakeMainTarget: text("bakeMainTarget"),
    });
  } else {
    return undefined;
  }
  return Object.keys(build).length > 0 ? build : undefined;
}

/**
 * The settings a ConfigMap holds, or nothing when it has no key, which
 * makes it no settings at all.
 *
 * @param configMap
 * @returns
 */
export function buildSettingsFrom(configMap: ConfigMap | undefined): BuildSettings | undefined {
  const data = configMap?.data ?? {};
  const key = data.key?.trim();
  if (key === undefined || key === "") {
    return undefined;
  }
  const projects: Record<string, Build> = {};
  try {
    const parsed: unknown = JSON.parse(data.projects ?? "{}");
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [project, value] of Object.entries(parsed)) {
        const build = storedBuild(value);
        if (build !== undefined) {
          projects[project.toLowerCase()] = build;
        }
      }
    }
  } catch {
    // Written badly by hand: as if no project had anything of its own
  }
  const build = normaliseBuild({
    dockerfile: data.dockerfile,
    bakeFile: data.bakeFile,
    bakeTarget: data.bakeTarget,
    bakeMainTarget: data.bakeMainTarget,
  });
  return { key, build, projects };
}

/**
 * The ConfigMap that holds the settings. Given the one it replaces,
 * keeps its resourceVersion, so a change made since it was read is
 * refused rather than overwritten, and its labels and annotations.
 *
 * @param namespace
 * @param settings
 * @param labels
 * @param existing
 * @returns
 */
export function buildsConfigMap(
  namespace: string,
  settings: BuildSettings,
  labels: Record<string, string>,
  existing?: ConfigMap,
): ConfigMap {
  const projects = Object.fromEntries(
    Object.entries(settings.projects)
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([project, build]) => [project, normaliseBuild(build)]),
  );
  return {
    metadata: {
      ...existing?.metadata,
      name: BUILDS_CONFIG_MAP,
      namespace,
      labels: { ...existing?.metadata.labels, ...labels },
    },
    data: {
      key: settings.key,
      ...normaliseBuild(settings.build),
      projects: JSON.stringify(projects, null, 2) + "\n",
    },
  };
}

/**
 * Where a project's builds find things: its own, then the namespace's,
 * field by field.
 *
 * @param settings
 * @param project its path, as group/name
 * @returns
 */
export function buildFor(settings: BuildSettings | undefined, project: string): Build {
  return { ...settings?.build, ...settings?.projects[project.toLowerCase()] };
}

/**
 * What a blank field means.
 *
 * @param field
 * @returns
 */
function defaultFor(field: keyof Build): string | undefined {
  return field === "dockerfile" ? DEFAULT_DOCKERFILE : field === "bakeTarget" ? DEFAULT_BAKE_TARGET : undefined;
}

/**
 * The settings with a project's own set, keeping only what differs from
 * the namespace's, and none at all when nothing does.
 *
 * @param settings
 * @param project
 * @param build
 * @returns
 */
export function withProjectBuild(settings: BuildSettings, project: string, build: Build): BuildSettings {
  const own = normaliseBuild(build);
  const namespace = normaliseBuild(settings.build);
  for (const field of BUILD_FIELDS) {
    if (own[field] !== undefined && own[field] === (namespace[field] ?? defaultFor(field))) {
      delete own[field];
    }
  }
  const projects = { ...settings.projects };
  if (Object.keys(own).length === 0) {
    delete projects[project.toLowerCase()];
  } else {
    projects[project.toLowerCase()] = own;
  }
  return { ...settings, projects };
}

/**
 * What a project sets for itself, in a few words.
 *
 * @param build
 * @returns
 */
export function describeBuild(build: Build): string {
  const { dockerfile, bakeFile, bakeTarget, bakeMainTarget } = normaliseBuild(build);
  return [
    dockerfile && `Dockerfile ${dockerfile}`,
    bakeFile && `bake file ${bakeFile}`,
    bakeTarget && `bake target ${bakeTarget}`,
    bakeMainTarget && `main target ${bakeMainTarget}`,
  ]
    .filter(Boolean)
    .join(", ");
}

// A path in the repository: letters, digits and . _ - in segments, no
// "..", nothing that would need quoting in the build's shell
const REPOSITORY_PATH = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

// A bake target's name, as bake allows them
const BAKE_TARGET = /^[A-Za-z0-9_-]+$/;

/**
 * What's wrong with a path in the repository, as a sentence, or
 * nothing. A blank one is fine: it means the default.
 *
 * @param path
 * @param example
 * @returns
 */
function pathProblem(path: string | undefined, example: string): string | undefined {
  const normalised = normalisePath(path ?? "");
  if (normalised === "") {
    return undefined;
  }
  if (!REPOSITORY_PATH.test(normalised) || normalised.split("/").some((segment) => segment === "..")) {
    return `A path from the top of the repository, such as ${example}: letters, digits, dots, hyphens, underscores and slashes.`;
  }
  return undefined;
}

/**
 * What's wrong with each of a build's fields, by field. Empty when it's
 * fine.
 *
 * @param build
 * @returns
 */
export function buildProblems(build: Build): Partial<Record<keyof Build, string>> {
  const problems: Partial<Record<keyof Build, string>> = {};
  const dockerfile = pathProblem(build.dockerfile, "ops/docker/Dockerfile");
  if (dockerfile) problems.dockerfile = dockerfile;
  const bakeFile = pathProblem(build.bakeFile, "docker-bake.hcl");
  if (bakeFile) problems.bakeFile = bakeFile;
  for (const field of ["bakeTarget", "bakeMainTarget"] as const) {
    const target = build[field]?.trim() ?? "";
    if (target !== "" && !BAKE_TARGET.test(target)) {
      problems[field] = "A target's name: letters, digits, hyphens and underscores.";
    }
  }
  return problems;
}

/**
 * Where GitLab fetches a project's build from.
 *
 * @param publicUrl Meteorologist's own address
 * @param builder
 * @param namespace
 * @param key
 * @param project its path, as group/name
 * @returns
 */
export function includeUrl(
  publicUrl: string,
  builder: Builder,
  namespace: string,
  key: string,
  project: string,
): string {
  const path = project.split("/").map(encodeURIComponent).join("/");
  return `${publicUrl}/${BUILDER_PATHS[builder]}/${encodeURIComponent(namespace)}/${encodeURIComponent(key)}/${path}.yml`;
}

/**
 * The project a served URL's last segments name, without the .yml, or
 * nothing when they don't end in a YAML file's name.
 *
 * @param segments
 * @returns
 */
export function projectFromSegments(segments: string[]): string | undefined {
  const last = segments.at(-1);
  const match = last?.match(/^(.+)\.ya?ml$/i);
  if (match === null || match === undefined) {
    return undefined;
  }
  return [...segments.slice(0, -1), match[1] ?? ""].map((segment) => decodeURIComponent(segment)).join("/");
}

/**
 * What goes in a project's .gitlab-ci.yml.
 *
 * @param url
 * @returns
 */
export function includeSnippet(url: string): string {
  return `include:\n  - remote: "${url}"\n`;
}

// What every build pushes, as its header says
const TAGS = `#
# Tags pushed:
#   $CI_REGISTRY_IMAGE:$CI_COMMIT_SHORT_SHA  (immutable, per commit)
#   $CI_REGISTRY_IMAGE:latest                (moves with the default branch)
`;

// The top of every build's job, and what logs in to the registry
const JOB = `stages:
  - build

docker-build:
  stage: build
  image: docker:27
  services:
    - docker:27-dind
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
  before_script:
    - echo "$CI_REGISTRY_PASSWORD" | docker login -u "$CI_REGISTRY_USER" --password-stdin "$CI_REGISTRY"`;

/**
 * The build GitLab runs.
 *
 * @param builder
 * @param build already checked with buildProblems
 * @returns
 */
export function ciFile(builder: Builder, build: Build): string {
  const { dockerfile, bakeFile, bakeTarget, bakeMainTarget } = normaliseBuild(build);
  if (builder === "bake") {
    const target = bakeTarget ?? DEFAULT_BAKE_TARGET;
    return `# Served by Meteorologist. Builds bake target ${target}${bakeFile ? ` from ${bakeFile}` : ""} and pushes it
# to this project's container registry on every push to the default
# branch, where Cirrus finds it by the commit. These tags replace any
# the bake file gives.
#
# A group builds several images, each pushed to a repository of its
# own: target "api" to $CI_REGISTRY_IMAGE/api. ${
      bakeMainTarget
        ? `Target ${bakeMainTarget} is
# pushed to $CI_REGISTRY_IMAGE itself.`
        : `A build of one target is
# pushed to $CI_REGISTRY_IMAGE itself.`
    } Each is tagged as below, with its
# own repository in place of $CI_REGISTRY_IMAGE.
${TAGS}
${JOB}
  variables:
    DOCKER_TLS_CERTDIR: "/certs"
    BAKE_FILE: "${bakeFile ?? ""}"
    BAKE_TARGET: "${target}"
    BAKE_MAIN_TARGET: "${bakeMainTarget ?? ""}"
  script:
    # Which images the target builds: itself, or each target in its group
    - apk add --no-cache jq > /dev/null
    - |
      files=""
      if [ -n "$BAKE_FILE" ]; then files="--file $BAKE_FILE"; fi
      targets=$(docker buildx bake $files --print "$BAKE_TARGET" | jq -r '.target | keys[]')
      count=$(echo "$targets" | wc -w)
      if [ -n "$BAKE_MAIN_TARGET" ] && ! echo "$targets" | grep -qx "$BAKE_MAIN_TARGET"; then
        echo "Warning: the main target $BAKE_MAIN_TARGET isn't among those $BAKE_TARGET builds ($(echo $targets)), so nothing is pushed to $CI_REGISTRY_IMAGE itself"
      fi
      set --
      for each in $targets; do
        if [ "$each" = "$BAKE_MAIN_TARGET" ] || { [ -z "$BAKE_MAIN_TARGET" ] && [ "$count" -eq 1 ]; }; then
          repository="$CI_REGISTRY_IMAGE"
        else
          repository="$CI_REGISTRY_IMAGE/$(echo "$each" | tr 'A-Z' 'a-z')"
        fi
        echo "$each: $repository"
        # Reuse layers from the target's previous latest image (inline cache) when it exists
        set -- "$@" \\
          --set "$each.tags=$repository:$CI_COMMIT_SHORT_SHA" \\
          --set "$each.tags=$repository:latest" \\
          --set "$each.cache-from=type=registry,ref=$repository:latest" \\
          --set "$each.cache-to=type=inline"
      done
      docker buildx bake $files "$@" --push "$BAKE_TARGET"
`;
  }
  const file = dockerfile ?? DEFAULT_DOCKERFILE;
  return `# Served by Meteorologist. Builds the image from ${file} and pushes
# it to this project's container registry on every push to the default
# branch, where Cirrus finds it by the commit.
${TAGS}
${JOB}
  variables:
    DOCKER_TLS_CERTDIR: "/certs"
    DOCKER_BUILDKIT: "1"
    DOCKERFILE: "${file}"
  script:
    # Reuse layers from the previous latest image (inline cache) when it exists.
    - docker pull "$CI_REGISTRY_IMAGE:latest" || true
    - >
      docker build
      --file "$DOCKERFILE"
      --build-arg BUILDKIT_INLINE_CACHE=1
      --cache-from "$CI_REGISTRY_IMAGE:latest"
      --tag "$CI_REGISTRY_IMAGE:$CI_COMMIT_SHORT_SHA"
      --tag "$CI_REGISTRY_IMAGE:latest"
      .
    - docker push "$CI_REGISTRY_IMAGE:$CI_COMMIT_SHORT_SHA"
    - docker push "$CI_REGISTRY_IMAGE:latest"
`;
}
