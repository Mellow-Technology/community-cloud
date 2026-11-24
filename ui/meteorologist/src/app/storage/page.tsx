/**
 * @file
 * Storage's Buckets tab: every SeaweedFS Bucket, across namespaces or
 * in one, with an overview of how they're doing and how full they are.
 */
import type { Metadata } from "next";
import { Button } from "gui-mellow/Button";

import { BucketList } from "@/components/BucketList";
import { StorageShell } from "@/components/StorageShell";
import { getKube } from "@/lib/kube";
import { settle } from "@/lib/kube/client";
import { namespacesAllowing, reachableNamespaces } from "@/lib/namespace/access";
import { BUCKET_GROUP, BUCKET_PLURAL } from "@/lib/storage/types";

export const metadata: Metadata = { title: "Storage" };

/**
 * @param props
 * @param props.searchParams
 * @returns
 */
export default async function StoragePage({ searchParams }: { searchParams: Promise<{ namespace?: string }> }) {
  const { namespace } = await searchParams;
  const kube = await getKube();
  const namespaces = await settle(() => reachableNamespaces(kube));
  const reached = namespaces.ok ? namespaces.value : [];
  const creatable = await namespacesAllowing(
    kube,
    { verb: "create", resource: BUCKET_PLURAL, group: BUCKET_GROUP },
    namespace ? [namespace] : reached.map((ns) => ns.metadata.name),
  );

  return (
    <StorageShell
      tab="buckets"
      namespace={namespace}
      namespaces={namespaces}
      actions={
        creatable.size > 0 ? (
          <Button href={namespace ? `/storage/new?namespace=${encodeURIComponent(namespace)}` : "/storage/new"}>
            New bucket
          </Button>
        ) : undefined
      }
    >
      <BucketList namespace={namespace} namespaces={reached} canCreate={creatable.size > 0} />
    </StorageShell>
  );
}
