/**
 * @file
 * A project's GitLab CI build, as served for its .gitlab-ci.yml to
 * include: by app/ci/gitlab (docker build) and app/ci/gitlab-bake
 * (buildx bake).
 *
 * GitLab fetches these when a pipeline starts, signed in as no one, so
 * they're read with Meteorologist's own account and the key in the URL
 * is what stands in for signing in. Every way of not finding one, from a
 * namespace that isn't there to a wrong key, is the same 404, so the
 * answer says nothing about which namespaces or projects there are.
 *
 * See builds.ts.
 */
import "server-only";

import { getOwnKube } from "../kube";
import { keyMatches } from "./buildKeys";
import { BUILDS_CONFIG_MAP, buildFor, buildSettingsFrom, ciFile, projectFromSegments, type Builder } from "./builds";

// Namespace names are DNS labels
const NAMESPACE = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;

/**
 * The parameters both routes are given.
 */
export interface BuildParams {
  namespace: string;
  key: string;
  project: string[];
}

/**
 * @returns
 */
function notFound(): Response {
  return new Response("Not found\n", {
    status: 404,
    headers: { "content-type": "text/plain", "cache-control": "no-store" },
  });
}

/**
 * The build a URL asks for, or a 404.
 *
 * @param builder
 * @param params
 * @returns
 */
export async function serveBuild(builder: Builder, params: BuildParams): Promise<Response> {
  const { namespace, key, project: segments } = params;
  const project = projectFromSegments(segments);
  if (project === undefined || !NAMESPACE.test(namespace)) {
    return notFound();
  }
  let settings;
  try {
    settings = buildSettingsFrom(await (await getOwnKube()).getConfigMap(namespace, BUILDS_CONFIG_MAP));
  } catch (error) {
    // Meteorologist can't read its own settings: worth a line in its log,
    // and still only a 404 to whoever asked
    console.error(`Couldn't read the GitLab build settings in ${namespace}:`, error);
    return notFound();
  }
  if (settings === undefined || !keyMatches(decodeURIComponent(key), settings.key)) {
    return notFound();
  }
  return new Response(ciFile(builder, buildFor(settings, project)), {
    headers: { "content-type": "text/yaml; charset=utf-8", "cache-control": "no-store" },
  });
}
