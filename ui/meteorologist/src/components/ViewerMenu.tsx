/**
 * @file
 * Who requests are being made as, and the way to sign out.
 *
 * Shown in the header because it's the answer to most "why can't I
 * see that" questions: everything here is done with this person's own
 * permissions.
 */
import { Badge } from "gui-mellow/Badge";
import { Button } from "gui-mellow/Button";

import type { Viewer } from "@/lib/kube";
import styles from "./ViewerMenu.module.scss";

/**
 * @param props
 * @param props.viewer
 * @returns
 */
export function ViewerMenu({ viewer }: { viewer: Viewer }) {
  if (viewer.mode !== "user") {
    return (
      <Badge tone="warning" dot>
        {viewer.mode}
      </Badge>
    );
  }

  return (
    <form action="/auth/logout" method="post" className={styles.viewer}>
      <span className={styles.name} title={viewer.groups.join(", ")}>
        {viewer.username}
      </span>
      <Button type="submit" variant="ghost" size="sm">
        Sign out
      </Button>
    </form>
  );
}
