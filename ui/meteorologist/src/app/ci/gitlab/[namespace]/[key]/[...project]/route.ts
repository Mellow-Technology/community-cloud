/**
 * @file
 * A project's GitLab CI build, for its .gitlab-ci.yml to include.
 *
 * GitLab fetches this when a pipeline starts, signed in as no one, so
 * it's read with Meteorologist's own account and the key in the URL is
 * what stands in for signing in. Every way of not finding it, from a
 * namespace that isn't there to a wrong key, is the same 404, so the
 * answer says nothing about which namespaces or projects there are.
 *
 * See src/lib/gitlab/builds.ts.
 */
import { keyMatches } from "@/lib/gitlab/buildKeys";
import { BUILDS_CONFIG_MAP, buildSettingsFrom, ciFile, dockerfileFor, projectFromSegments } from "@/lib/gitlab/builds";
import { getOwnKube } from "@/lib/kube";

// Read on every fetch: a changed path or key counts from the next pipeline
export const dynamic = "force-dynamic";

// Namespace names are DNS labels
const NAMESPACE = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;

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
 * @param _request
 * @param context
 * @param context.params
 * @returns
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ namespace: string; key: string; project: string[] }> },
): Promise<Response> {
  const { namespace, key, project: segments } = await params;
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
  return new Response(ciFile(dockerfileFor(settings, project)), {
    headers: { "content-type": "text/yaml; charset=utf-8", "cache-control": "no-store" },
  });
}
