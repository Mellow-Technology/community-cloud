/**
 * @file
 * A namespace's Applications tab: the applications list, for that
 * namespace alone, under the namespace's header and tabs. A route of
 * its own rather than a panel of the namespace page, so the rest of
 * that page isn't read for it and its live updates only redraw this.
 *
 * The header and tabs come first and the list streams in after, with
 * placeholder rows until it does; loading.tsx stands in for the whole
 * page while even the namespace is being read.
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { ApplicationList, ApplicationListPlaceholder } from "@/components/ApplicationList";
import { ErrorNotice } from "@/components/ErrorNotice";
import { NamespaceHeader } from "@/components/NamespaceHeader";
import { NamespaceTabs } from "@/components/NamespaceTabs";
import { PageHeader } from "@/components/PageHeader";
import { getKube } from "@/lib/kube";
import { isNotFound, settle } from "@/lib/kube/client";
import { namespacesAllowing } from "@/lib/namespace/access";
import { GROUP, PLURAL } from "@/lib/webapp/types";

/**
 * @param props
 * @param props.params
 * @returns
 */
export async function generateMetadata({ params }: { params: Promise<{ name: string }> }): Promise<Metadata> {
  return { title: `Applications in ${decodeURIComponent((await params).name)}` };
}

/**
 * @param props
 * @param props.params
 * @returns
 */
export default async function NamespaceApplicationsPage({ params }: { params: Promise<{ name: string }> }) {
  const name = decodeURIComponent((await params).name);
  const kube = await getKube();
  const [found, deploying] = await Promise.all([
    settle(() => kube.getNamespace(name)),
    namespacesAllowing(kube, { verb: "create", resource: PLURAL, group: GROUP }, [name]),
  ]);

  if (!found.ok) {
    if (isNotFound(found.error)) {
      notFound();
    }
    return (
      <>
        <PageHeader title={name} back={{ href: "/namespaces", label: "Namespaces" }} />
        <ErrorNotice error={found.error} title="Couldn't read this namespace" />
      </>
    );
  }

  return (
    <>
      <NamespaceHeader name={name} canDeploy={deploying.size > 0} />
      <NamespaceTabs
        namespace={name}
        selected="applications"
        panels={{
          // The header and tabs first, then the list once it's read
          applications: (
            <Suspense fallback={<ApplicationListPlaceholder showNamespace={false} />}>
              <ApplicationList namespace={name} canCreate={deploying.size > 0} showNamespace={false} />
            </Suspense>
          ),
        }}
      />
    </>
  );
}
