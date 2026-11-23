/**
 * @file
 * Building images on GitLab CI from a file Meteorologist serves.
 *
 * A project's .gitlab-ci.yml includes one line, a remote include of a
 * URL here, and GitLab fetches the build from it each time a pipeline
 * starts. The build is the same for everything: Docker in Docker,
 * tagging the image with the commit's short SHA, which is one of the
 * tags Cirrus looks for, and pushing it to the project's registry. What
 * differs is where the Dockerfile is, so that's all there is to set: a
 * default for the namespace, and a path for any project whose Dockerfile
 * is somewhere else.
 *
 * GitLab fetches the file without signing in, so the URL carries a key
 * that only the namespace's settings know. The settings are a
 * ConfigMap in the namespace with one fixed name, which Meteorologist's
 * own account may read and nothing else of: the file is served without
 * anyone signed in to read it as. It holds paths and the key, nothing
 * a token could get at.
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

/**
 * A namespace's build settings.
 *
 * - key: what the include URL has to carry
 * - dockerfile: the namespace's default, when it has one
 * - projects: Dockerfile paths by project path, lower-cased, for the
 *   projects that differ from the default
 */
export interface BuildSettings {
  key: string;
  dockerfile?: string;
  projects: Record<string, string>;
}

/**
 * The settings a ConfigMap holds, or nothing when it has no key, which
 * makes it no settings at all.
 *
 * @param configMap
 * @returns
 */
export function buildSettingsFrom(configMap: ConfigMap | undefined): BuildSettings | undefined {
  const key = configMap?.data?.key?.trim();
  if (key === undefined || key === "") {
    return undefined;
  }
  let projects: Record<string, string> = {};
  try {
    const parsed: unknown = JSON.parse(configMap?.data?.projects ?? "{}");
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      projects = Object.fromEntries(
        Object.entries(parsed)
          .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== "")
          .map(([project, path]) => [project.toLowerCase(), path]),
      );
    }
  } catch {
    // Written badly by hand: as if no project had a path of its own
  }
  const dockerfile = configMap?.data?.dockerfile?.trim();
  return { key, dockerfile: dockerfile || undefined, projects };
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
  const projects = Object.fromEntries(Object.entries(settings.projects).toSorted(([a], [b]) => a.localeCompare(b)));
  return {
    metadata: {
      ...existing?.metadata,
      name: BUILDS_CONFIG_MAP,
      namespace,
      labels: { ...existing?.metadata.labels, ...labels },
    },
    data: {
      key: settings.key,
      ...(settings.dockerfile ? { dockerfile: settings.dockerfile } : {}),
      projects: JSON.stringify(projects, null, 2) + "\n",
    },
  };
}

/**
 * The Dockerfile a project builds from.
 *
 * @param settings
 * @param project its path, as group/name
 * @returns
 */
export function dockerfileFor(settings: BuildSettings | undefined, project: string): string {
  return settings?.projects[project.toLowerCase()] ?? settings?.dockerfile ?? DEFAULT_DOCKERFILE;
}

/**
 * The settings with a project's own path set, or taken away when it's
 * blank or the same as the default.
 *
 * @param settings
 * @param project
 * @param dockerfile
 * @returns
 */
export function withProjectDockerfile(settings: BuildSettings, project: string, dockerfile: string): BuildSettings {
  const projects = { ...settings.projects };
  const path = normaliseDockerfile(dockerfile);
  if (path === "" || path === (settings.dockerfile ?? DEFAULT_DOCKERFILE)) {
    delete projects[project.toLowerCase()];
  } else {
    projects[project.toLowerCase()] = path;
  }
  return { ...settings, projects };
}

/**
 * A Dockerfile path as kept: trimmed, without a leading "./".
 *
 * @param path
 * @returns
 */
export function normaliseDockerfile(path: string): string {
  return path.trim().replace(/^(\.\/)+/, "");
}

// A path in the repository: letters, digits and . _ - in segments, no
// "..", nothing that would need quoting in the build's shell
const DOCKERFILE_PATH = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

/**
 * What's wrong with a Dockerfile path, as a sentence, or nothing. A
 * blank one is fine: it means the default.
 *
 * @param path
 * @returns
 */
export function dockerfileProblem(path: string): string | undefined {
  const normalised = normaliseDockerfile(path);
  if (normalised === "") {
    return undefined;
  }
  if (!DOCKERFILE_PATH.test(normalised) || normalised.split("/").some((segment) => segment === "..")) {
    return "A path from the top of the repository, such as ops/docker/Dockerfile: letters, digits, dots, hyphens, underscores and slashes.";
  }
  return undefined;
}

/**
 * Where GitLab fetches a project's build from.
 *
 * @param publicUrl Meteorologist's own address
 * @param namespace
 * @param key
 * @param project its path, as group/name
 * @returns
 */
export function includeUrl(publicUrl: string, namespace: string, key: string, project: string): string {
  const path = project.split("/").map(encodeURIComponent).join("/");
  return `${publicUrl}/ci/gitlab/${encodeURIComponent(namespace)}/${encodeURIComponent(key)}/${path}.yml`;
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

/**
 * The build GitLab runs.
 *
 * @param dockerfile already checked with dockerfileProblem
 * @returns
 */
export function ciFile(dockerfile: string): string {
  return `# Served by Meteorologist. Builds the image from ${dockerfile} and pushes
# it to this project's container registry on every push to the default
# branch, where Cirrus finds it by the commit.
#
# Tags pushed:
#   $CI_REGISTRY_IMAGE:$CI_COMMIT_SHORT_SHA  (immutable, per commit)
#   $CI_REGISTRY_IMAGE:latest                (moves with the default branch)

stages:
  - build

docker-build:
  stage: build
  image: docker:27
  services:
    - docker:27-dind
  variables:
    DOCKER_TLS_CERTDIR: "/certs"
    DOCKER_BUILDKIT: "1"
    DOCKERFILE: "${dockerfile}"
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
  before_script:
    - echo "$CI_REGISTRY_PASSWORD" | docker login -u "$CI_REGISTRY_USER" --password-stdin "$CI_REGISTRY"
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
