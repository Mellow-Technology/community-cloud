/**
 * @file
 * Changing a SeaweedFS Bucket.
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Alert } from "gui-mellow/Alert";

import { BucketForm } from "@/components/BucketForm";
import { ErrorNotice } from "@/components/ErrorNotice";
import { PageHeader } from "@/components/PageHeader";
import styles from "@/components/page.module.scss";
import { getKube } from "@/lib/kube";
import { isNotFound, settle } from "@/lib/kube/client";
import { reachableNamespaces } from "@/lib/namespace/access";
import { bucketNamespaceChoices, visibleUsers } from "@/lib/storage/choices";
import { toBucketForm } from "@/lib/storage/form";
import { bucketManager } from "@/lib/storage/present";

export const metadata: Metadata = { title: "Edit bucket" };

/**
 * @param props
 * @param props.params
 * @returns
 */
export default async function EditBucketPage({ params }: { params: Promise<{ namespace: string; name: string }> }) {
  const { namespace, name } = await params;
  const kube = await getKube();
  const [found, ns] = await Promise.all([
    settle(() => kube.getBucket(decodeURIComponent(namespace), decodeURIComponent(name))),
    settle(() => kube.getNamespace(decodeURIComponent(namespace))),
  ]);
  const back = { href: `/storage/${namespace}/${name}`, label: decodeURIComponent(name) };

  if (!found.ok) {
    if (isNotFound(found.error)) {
      notFound();
    }
    return (
      <>
        <PageHeader title="Edit bucket" back={back} />
        <ErrorNotice error={found.error} title="Couldn't read this bucket" />
      </>
    );
  }

  const bucket = found.value;
  const choices = ns.ok ? await bucketNamespaceChoices(kube, [ns.value]) : [];
  const reached = await settle(() => reachableNamespaces(kube));
  const users = await visibleUsers(kube, reached.ok ? reached.value : ns.ok ? [ns.value] : []);
  const manager = bucketManager(bucket);

  return (
    <>
      <PageHeader
        eyebrow={bucket.metadata.namespace}
        title={`Edit ${bucket.metadata.name}`}
        description="SeaweedFS applies changes as soon as they're saved."
        back={back}
      />
      {manager?.kind === "application" && (
        <Alert tone="warning" className={styles.stats}>
          Cirrus made this bucket for {manager.name}, and sets its name, access and quota again whenever it reconciles
          the application. Change those on the application instead; the rest is kept.
        </Alert>
      )}
      {manager?.kind === "installer" && (
        <Alert tone="warning" className={styles.stats}>
          The installer made this bucket for one of its packages, and sets what it chose again the next time it runs.
        </Alert>
      )}
      <BucketForm initial={toBucketForm(bucket)} existing={bucket} namespaces={choices} users={users} />
    </>
  );
}
