/**
 * @file
 * Adding one of SeaweedFS's S3 users, with its first key if asked.
 */
import type { Metadata } from "next";

import { ErrorNotice } from "@/components/ErrorNotice";
import { NewUserForm } from "@/components/NewUserForm";
import { NoNamespaces } from "@/components/NoNamespaces";
import { PageHeader } from "@/components/PageHeader";
import styles from "@/components/page.module.scss";
import { getKube } from "@/lib/kube";
import { settle } from "@/lib/kube/client";
import { namespacesAllowing, reachableNamespaces } from "@/lib/namespace/access";
import { bucketNamespaceChoices } from "@/lib/storage/choices";
import { storageTabHref } from "@/lib/storage/tabs";
import { BUCKET_GROUP } from "@/lib/storage/types";
import { emptyUserForm } from "@/lib/storage/userForm";

export const metadata: Metadata = { title: "Add user" };

/**
 * @param props
 * @param props.searchParams
 * @returns
 */
export default async function NewUserPage({ searchParams }: { searchParams: Promise<{ namespace?: string }> }) {
  const { namespace } = await searchParams;
  const kube = await getKube();
  const namespaces = await settle(() => reachableNamespaces(kube));
  const reached = namespaces.ok ? namespaces.value : [];
  // Only where it could be saved, which seeing a namespace doesn't mean
  const creatable = await namespacesAllowing(
    kube,
    { verb: "create", resource: "s3identities", group: BUCKET_GROUP },
    reached.map((ns) => ns.metadata.name),
  );
  const choices = await bucketNamespaceChoices(
    kube,
    reached.filter((ns) => creatable.has(ns.metadata.name)),
  );
  const only = choices.length === 1 ? choices[0]?.name : undefined;

  return (
    <>
      <PageHeader
        eyebrow="SeaweedFS"
        title="Add user"
        description="An S3 user, which buckets can give access to, and a key for it to sign in with."
        back={{ href: storageTabHref("users", namespace), label: "Users" }}
      />
      {!namespaces.ok && <ErrorNotice error={namespaces.error} title="Couldn't list namespaces" />}
      {namespaces.ok && choices.length === 0 ? (
        reached.length === 0 ? (
          <NoNamespaces />
        ) : (
          <p className={styles.empty}>
            You can see {reached.length === 1 ? "a namespace" : "some namespaces"}, but not add users in them. A cluster
            admin can change that.
          </p>
        )
      ) : (
        <NewUserForm initial={emptyUserForm(namespace ?? only ?? "")} namespaces={choices} />
      )}
    </>
  );
}
