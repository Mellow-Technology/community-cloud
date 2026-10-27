/**
 * @file
 * The Kubernetes client for the request being handled, and who it acts
 * as.
 *
 * Pages and actions call getKube() and get a client already set up for
 * the current person; they never see a token or a mode. The proxy has
 * already made sure a signed-in person's ID token is fresh, so this
 * only has to read it.
 */
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import "server-only";

import { SESSION_COOKIE, sessionIdentity, unsealSession } from "../auth/session";
import { getKubeMode, type KubeMode } from "../config";
import { apiServerClientForDevKubeconfig, apiServerClientForToken } from "./apiServer";
import type { KubeClient } from "./client";
import { fixtureClient } from "./fixtures";

/**
 * Who requests are made as, for the header.
 *
 * - mode: how the API is reached
 * - username and groups: from the ID token, when people sign in
 */
export interface Viewer {
  mode: KubeMode;
  username: string;
  groups: string[];
}

/**
 * The client for this request.
 *
 * @returns
 */
export async function getKube(): Promise<KubeClient> {
  const mode = getKubeMode();
  if (mode === "fixtures") {
    return fixtureClient();
  }
  if (mode === "kubeconfig") {
    return apiServerClientForDevKubeconfig();
  }

  const session = await unsealSession((await cookies()).get(SESSION_COOKIE)?.value);
  if (session === undefined) {
    // The proxy sends people without a session to sign in, so this is
    // only reached by one that ran out mid-request
    redirect("/auth/login");
  }
  return apiServerClientForToken(session.idToken);
}

/**
 * Who this request acts as.
 *
 * @returns nothing, when someone should be signed in and isn't
 */
export async function getViewer(): Promise<Viewer | undefined> {
  const mode = getKubeMode();
  if (mode === "fixtures") {
    return { mode, username: "fixtures", groups: [] };
  }
  if (mode === "kubeconfig") {
    return { mode, username: "kubeconfig", groups: [] };
  }
  const session = await unsealSession((await cookies()).get(SESSION_COOKIE)?.value);
  return session ? { mode, ...sessionIdentity(session) } : undefined;
}
