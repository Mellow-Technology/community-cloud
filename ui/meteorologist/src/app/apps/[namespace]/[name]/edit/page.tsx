/**
 * @file
 * Editing a WebApplication, with the guided form.
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ErrorNotice } from "@/components/ErrorNotice";
import { PageHeader } from "@/components/PageHeader";
import { WebApplicationForm } from "@/components/WebApplicationForm";
import { getKube } from "@/lib/kube";
import { isNotFound, settle } from "@/lib/kube/client";
import { toForm } from "@/lib/webapp/form";

export const metadata: Metadata = { title: "Edit application" };

/**
 * @param props
 * @param props.params
 * @returns
 */
export default async function EditAppPage({ params }: { params: Promise<{ namespace: string; name: string }> }) {
  const { namespace, name } = await params;
  const kube = await getKube();
  const [found, ns] = await Promise.all([
    settle(() => kube.getWebApplication(decodeURIComponent(namespace), decodeURIComponent(name))),
    settle(() => kube.getNamespace(decodeURIComponent(namespace))),
  ]);
  const back = { href: `/apps/${namespace}/${name}`, label: decodeURIComponent(name) };

  if (!found.ok) {
    if (isNotFound(found.error)) {
      notFound();
    }
    return (
      <>
        <PageHeader title="Edit application" back={back} />
        <ErrorNotice error={found.error} title="Couldn't read this application" />
      </>
    );
  }

  return (
    <>
      <PageHeader
        eyebrow={found.value.metadata.namespace}
        title={`Edit ${found.value.metadata.name}`}
        description="Changes are applied by Cirrus as soon as they're saved."
        back={back}
      />
      <WebApplicationForm
        initial={toForm(found.value)}
        resourceVersion={found.value.metadata.resourceVersion ?? ""}
        namespaces={ns.ok ? [{ name: ns.value.metadata.name, labels: ns.value.metadata.labels ?? {} }] : []}
      />
    </>
  );
}
