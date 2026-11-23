/**
 * @file
 * The header over each of a namespace's tabs, whichever route it's on.
 */
import { Button } from "gui-mellow/Button";

import { PageHeader } from "@/components/PageHeader";

/**
 * @param props
 * @param props.name the namespace
 * @param props.canDeploy whether to offer a new application in it
 * @returns
 */
export function NamespaceHeader({ name, canDeploy }: { name: string; canDeploy: boolean }) {
  return (
    <PageHeader
      eyebrow="Namespace"
      title={name}
      back={{ href: "/namespaces", label: "Namespaces" }}
      actions={
        canDeploy ? (
          <Button href={`/apps/new?namespace=${encodeURIComponent(name)}`}>New application</Button>
        ) : undefined
      }
    />
  );
}
