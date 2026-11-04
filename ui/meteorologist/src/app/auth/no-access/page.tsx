/**
 * @file
 * Where someone the API server won't accept lands after signing in.
 *
 * Outside the proxy's reach, like the rest of /auth, so it shows
 * without a session; there's deliberately none to show it with.
 */
import type { Metadata } from "next";
import { Button } from "gui-mellow/Button";

import { PageHeader } from "@/components/PageHeader";

export const metadata: Metadata = { title: "No cluster access" };

/**
 * @returns
 */
export default function NoAccess() {
  return (
    <PageHeader
      title="No cluster access yet"
      description={
        "You signed in, but the cluster doesn't accept your account yet. Ask a Community Cloud admin to add you " +
        'to one of the "k8s-" groups in Authentik, then sign in again.'
      }
      actions={
        <>
          <Button href="/auth/login">Sign in again</Button>
          <form action="/auth/logout" method="post">
            <Button type="submit" variant="ghost">
              Sign out
            </Button>
          </form>
        </>
      }
    />
  );
}
