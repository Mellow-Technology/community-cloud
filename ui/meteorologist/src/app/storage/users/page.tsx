/**
 * @file
 * Storage's Users tab: SeaweedFS's S3 users, from S3Identities, across
 * namespaces or in one.
 */
import type { Metadata } from "next";
import { Button } from "gui-mellow/Button";

import { StorageShell } from "@/components/StorageShell";
import { UserList } from "@/components/UserList";
import { getKube } from "@/lib/kube";
import { settle } from "@/lib/kube/client";
import { namespacesAllowing, reachableNamespaces } from "@/lib/namespace/access";
import { BUCKET_GROUP } from "@/lib/storage/types";

export const metadata: Metadata = { title: "Storage users" };

/**
 * @param props
 * @param props.searchParams
 * @returns
 */
export default async function StorageUsersPage({ searchParams }: { searchParams: Promise<{ namespace?: string }> }) {
  const { namespace } = await searchParams;
  const kube = await getKube();
  const namespaces = await settle(() => reachableNamespaces(kube));
  const reached = namespaces.ok ? namespaces.value : [];
  const creatable = await namespacesAllowing(
    kube,
    { verb: "create", resource: "s3identities", group: BUCKET_GROUP },
    namespace ? [namespace] : reached.map((ns) => ns.metadata.name),
  );

  return (
    <StorageShell
      tab="users"
      namespace={namespace}
      namespaces={namespaces}
      actions={
        creatable.size > 0 ? (
          <Button
            href={namespace ? `/storage/users/new?namespace=${encodeURIComponent(namespace)}` : "/storage/users/new"}
          >
            Add user
          </Button>
        ) : undefined
      }
    >
      <UserList namespace={namespace} namespaces={reached} />
    </StorageShell>
  );
}
