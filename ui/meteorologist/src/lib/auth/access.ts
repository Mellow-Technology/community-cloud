/**
 * @file
 * Whether the API server takes someone who just signed in.
 *
 * Authentik only lets people through to Meteorologist when they're in
 * a "k8s-" group, the rule the API server applies too (see
 * k8s/apps/meteorologist/Meteorologist.blueprint.yaml). This is the
 * same question put to the API server itself, so that anything else
 * that comes between them — a group renamed, an issuer the API server
 * wasn't told about — ends at a page saying so rather than a session
 * of errors.
 */
import { KubeError, type KubeClient } from "../kube/client";

/**
 * Whether the API server refuses the person outright.
 *
 * Only a 401 counts. An API server that can't be reached, or answers
 * something else, says nothing about the person, so they're let in to
 * see that on the pages.
 *
 * @param kube a client acting as the person
 * @returns
 */
export async function refusedByApiServer(kube: Pick<KubeClient, "whoAmI">): Promise<boolean> {
  try {
    await kube.whoAmI();
    return false;
  } catch (error) {
    return error instanceof KubeError && error.status === 401;
  }
}
