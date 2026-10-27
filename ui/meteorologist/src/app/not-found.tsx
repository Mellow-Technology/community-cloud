/**
 * @file
 * For a page, or a resource, that isn't there.
 */
import { Button } from "gui-mellow/Button";

import { PageHeader } from "@/components/PageHeader";

/**
 * @returns
 */
export default function NotFound() {
  return (
    <PageHeader
      title="Not found"
      description="There's nothing here, or it's been deleted, or it's in a namespace you can't see."
      actions={<Button href="/">Overview</Button>}
    />
  );
}
