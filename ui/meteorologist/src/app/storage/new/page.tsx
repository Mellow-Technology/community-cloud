/**
 * @file
 * Making a SeaweedFS Bucket.
 */
import type { Metadata } from "next";

import { BucketForm } from "@/components/BucketForm";
import { ErrorNotice } from "@/components/ErrorNotice";
import { NoNamespaces } from "@/components/NoNamespaces";
import { PageHeader } from "@/components/PageHeader";
import styles from "@/components/page.module.scss";
import { getKube } from "@/lib/kube";
import { settle } from "@/lib/kube/client";
import { namespacesAllowing, reachableNamespaces } from "@/lib/namespace/access";
import { bucketNamespaceChoices, visibleUsers } from "@/lib/storage/choices";
import { emptyBucketForm } from "@/lib/storage/form";
import { BUCKET_GROUP, BUCKET_PLURAL } from "@/lib/storage/types";

export const metadata: Metadata = { title: "New bucket" };

/**
 * @param props
 * @param props.searchParams
 * @returns
 */
export default async function NewBucketPage({ searchParams }: { searchParams: Promise<{ namespace?: string }> }) {
  const { namespace } = await searchParams;
  const kube = await getKube();
  const namespaces = await settle(() => reachableNamespaces(kube));
  const reached = namespaces.ok ? namespaces.value : [];
  // Only where it could be saved, which seeing a namespace doesn't mean
  const creatable = await namespacesAllowing(
    kube,
    { verb: "create", resource: BUCKET_PLURAL, group: BUCKET_GROUP },
    reached.map((ns) => ns.metadata.name),
  );
  const choices = await bucketNamespaceChoices(
    kube,
    reached.filter((ns) => creatable.has(ns.metadata.name)),
  );
  const users = await visibleUsers(kube, reached);
  const only = choices.length === 1 ? choices[0]?.name : undefined;

  return (
    <>
      <PageHeader
        eyebrow="SeaweedFS"
        title="New bucket"
        description="SeaweedFS makes it as soon as it's saved."
        back={{ href: "/storage", label: "Storage" }}
      />
      {!namespaces.ok && <ErrorNotice error={namespaces.error} title="Couldn't list namespaces" />}
      {namespaces.ok && choices.length === 0 ? (
        reached.length === 0 ? (
          <NoNamespaces />
        ) : (
          <p className={styles.empty}>
            You can see {reached.length === 1 ? "a namespace" : "some namespaces"}, but not make buckets in them. A
            cluster admin can change that.
          </p>
        )
      ) : (
        <BucketForm initial={emptyBucketForm(namespace ?? only ?? "")} namespaces={choices} users={users} />
      )}
    </>
  );
}
