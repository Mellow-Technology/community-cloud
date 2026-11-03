/**
 * @file
 * Which of a namespace's registry credentials an image needs.
 *
 * A pull Secret is for one registry or a few: its .dockerconfigjson
 * holds credentials by registry host. Meteorologist records the host on
 * the Secrets it makes, in an annotation, and reads it out of the
 * Secret itself for one made some other way, so the form can choose the
 * credentials for an image's registry rather than have them typed in.
 *
 * Naming a pull Secret on an application replaces the namespace's
 * defaults for its pods, rather than adding to them, which is why the
 * choice is only ever the Secrets for the image's own registry.
 */

// Where Meteorologist records the registry a pull Secret is for
export const REGISTRY_ANNOTATION = "community-cloud.technology/registry";

// Docker Hub, for an image named without a registry, and the names its
// credentials are kept under
const DOCKER_HUB = "docker.io";
const DOCKER_HUB_ALIASES = ["index.docker.io", "registry-1.docker.io", "registry.hub.docker.com"];

/**
 * A namespace's pull Secret, and the registries it has credentials for.
 */
export interface PullSecret {
  name: string;
  registries: string[];
}

/**
 * A registry's host as credentials and images both name it: no scheme,
 * no path, lower-case, Docker Hub's many names as one.
 *
 * @param server
 * @returns
 */
export function normaliseRegistry(server: string): string {
  const host = (
    server
      .trim()
      .replace(/^[a-z]+:\/\//i, "")
      .split("/")[0] ?? ""
  ).toLowerCase();
  return DOCKER_HUB_ALIASES.includes(host) ? DOCKER_HUB : host;
}

/**
 * The registry an image is pulled from. As Docker reads a reference: the
 * first part is a registry when it looks like a host — it has a dot or a
 * port, or is localhost — and otherwise the image is on Docker Hub.
 *
 * @param image without a tag or digest is fine; either is ignored
 * @returns
 */
export function registryOf(image: string): string | undefined {
  const reference = image.trim();
  if (reference === "") {
    return undefined;
  }
  const first = reference.split("/")[0] ?? "";
  const isHost = reference.includes("/") && (first.includes(".") || first.includes(":") || first === "localhost");
  return isHost ? normaliseRegistry(first) : DOCKER_HUB;
}

/**
 * The registries a .dockerconfigjson has credentials for.
 *
 * @param dockerConfig the Secret's .dockerconfigjson, as text
 * @returns empty when it can't be read
 */
export function registriesIn(dockerConfig: string | undefined): string[] {
  try {
    const parsed = JSON.parse(dockerConfig ?? "") as { auths?: Record<string, unknown> };
    return [...new Set(Object.keys(parsed.auths ?? {}).map(normaliseRegistry))].filter((host) => host !== "");
  } catch {
    return [];
  }
}

/**
 * The pull Secrets for an image's registry.
 *
 * @param image
 * @param secrets the namespace's
 * @returns their names
 */
export function pullSecretsFor(image: string, secrets: PullSecret[]): string[] {
  const registry = registryOf(image);
  return registry === undefined
    ? []
    : secrets.filter((secret) => secret.registries.includes(registry)).map((secret) => secret.name);
}
