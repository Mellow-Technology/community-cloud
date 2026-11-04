/**
 * @file
 * Creating a WebApplication, with the guided form.
 */
import type { Metadata } from "next";

import { ErrorNotice } from "@/components/ErrorNotice";
import { PageHeader } from "@/components/PageHeader";
import { WebApplicationForm } from "@/components/WebApplicationForm";
import { getKube } from "@/lib/kube";
import { settle } from "@/lib/kube/client";
import { namespaceChoices } from "@/lib/namespace/choices";
import { emptyForm, soleConnection } from "@/lib/webapp/form";

export const metadata: Metadata = { title: "New application" };

/**
 * @param props
 * @param props.searchParams
 * @returns
 */
export default async function NewAppPage({ searchParams }: { searchParams: Promise<{ namespace?: string }> }) {
  const { namespace } = await searchParams;
  const kube = await getKube();
  const namespaces = await settle(() => kube.listNamespaces());
  const choices = namespaces.ok ? await namespaceChoices(kube, namespaces.value) : [];

  return (
    <>
      <PageHeader
        eyebrow="Cirrus"
        title="New application"
        description="Say what to run and what it needs. Cirrus makes the database, bucket, queue, addresses and rollouts."
        back={{ href: "/apps", label: "Applications" }}
      />
      {!namespaces.ok && <ErrorNotice error={namespaces.error} title="Couldn't list namespaces" />}
      <WebApplicationForm
        initial={{
          ...emptyForm(namespace ?? ""),
          ...soleConnection(choices.find((choice) => choice.name === namespace)),
        }}
        namespaces={choices}
      />
    </>
  );
}
