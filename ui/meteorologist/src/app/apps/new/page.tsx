/**
 * @file
 * Creating a WebApplication, with the guided form.
 */
import type { Metadata } from "next";

import { ErrorNotice } from "@/components/ErrorNotice";
import { NoNamespaces } from "@/components/NoNamespaces";
import { PageHeader } from "@/components/PageHeader";
import { WebApplicationForm } from "@/components/WebApplicationForm";
import styles from "@/components/page.module.scss";
import { getKube } from "@/lib/kube";
import { settle } from "@/lib/kube/client";
import { namespacesAllowing, reachableNamespaces } from "@/lib/namespace/access";
import { namespaceChoices } from "@/lib/namespace/choices";
import { offeringChoices } from "@/lib/offerings/choices";
import { emptyForm, soleConnection } from "@/lib/webapp/form";
import { GROUP, PLURAL } from "@/lib/webapp/types";

export const metadata: Metadata = { title: "New application" };

/**
 * @param props
 * @param props.searchParams
 * @returns
 */
export default async function NewAppPage({ searchParams }: { searchParams: Promise<{ namespace?: string }> }) {
  const { namespace } = await searchParams;
  const kube = await getKube();
  const namespaces = await settle(() => reachableNamespaces(kube));
  const reached = namespaces.ok ? namespaces.value : [];
  // Only where it could be saved, which seeing a namespace doesn't mean
  const deployable = await namespacesAllowing(
    kube,
    { verb: "create", resource: PLURAL, group: GROUP },
    reached.map((ns) => ns.metadata.name),
  );
  const [choices, offerings] = await Promise.all([
    namespaceChoices(
      kube,
      reached.filter((ns) => deployable.has(ns.metadata.name)),
    ),
    offeringChoices(kube, reached),
  ]);

  return (
    <>
      <PageHeader
        eyebrow="Cirrus"
        title="New application"
        description="Say what to run and what it needs. Cirrus makes the database, bucket, queue, addresses and rollouts."
        back={{ href: "/apps", label: "Applications" }}
      />
      {!namespaces.ok && <ErrorNotice error={namespaces.error} title="Couldn't list namespaces" />}
      {namespaces.ok && choices.length === 0 ? (
        reached.length === 0 ? (
          <NoNamespaces />
        ) : (
          <p className={styles.empty}>
            You can see {reached.length === 1 ? "a namespace" : "some namespaces"}, but not make applications in them. A
            cluster admin can change that.
          </p>
        )
      ) : (
        <WebApplicationForm
          initial={{
            ...emptyForm(namespace ?? ""),
            ...soleConnection(choices.find((choice) => choice.name === namespace)),
          }}
          namespaces={choices}
          offerings={offerings}
        />
      )}
    </>
  );
}
