/**
 * @file
 * What went wrong reading from the cluster, said in the page rather
 * than as an error screen, so the rest of the page still works.
 */
import { Alert } from "gui-mellow/Alert";

import { describeError, isForbidden } from "@/lib/kube/client";

/**
 * @param props
 * @param props.error whatever the client threw
 * @param props.title what was being attempted
 * @returns
 */
export function ErrorNotice({ error, title }: { error: unknown; title: string }) {
  return (
    <Alert tone={isForbidden(error) ? "warning" : "danger"} title={title} role="alert">
      {describeError(error)}
    </Alert>
  );
}
