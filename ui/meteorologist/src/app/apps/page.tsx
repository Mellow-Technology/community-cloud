/**
 * @file
 * Every WebApplication, across namespaces or in one.
 */
import type { Metadata } from "next";
import { Button } from "gui-mellow/Button";
import { SelectField } from "gui-mellow/Field";

import { ApplicationList } from "@/components/ApplicationList";
import { ErrorNotice } from "@/components/ErrorNotice";
import { NoNamespaces } from "@/components/NoNamespaces";
import { PageHeader } from "@/components/PageHeader";
import styles from "@/components/page.module.scss";
import { getKube } from "@/lib/kube";
import { settle } from "@/lib/kube/client";
import { namespacesAllowing, reachableNamespaces } from "@/lib/namespace/access";
import { GROUP, PLURAL } from "@/lib/webapp/types";

export const metadata: Metadata = { title: "Applications" };

/**
 * @param props
 * @param props.searchParams
 * @returns
 */
export default async function AppsPage({ searchParams }: { searchParams: Promise<{ namespace?: string }> }) {
  const { namespace } = await searchParams;
  const kube = await getKube();
  const namespaces = await settle(() => reachableNamespaces(kube));
  const reached = namespaces.ok ? namespaces.value : [];
  const deployable = await namespacesAllowing(
    kube,
    { verb: "create", resource: PLURAL, group: GROUP },
    namespace ? [namespace] : reached.map((ns) => ns.metadata.name),
  );

  return (
    <>
      <PageHeader
        eyebrow="Cirrus"
        title="Applications"
        description="WebApplications: an image, and what it needs to run, which Cirrus provides."
        actions={
          deployable.size > 0 ? (
            <Button href={namespace ? `/apps/new?namespace=${encodeURIComponent(namespace)}` : "/apps/new"}>
              New application
            </Button>
          ) : undefined
        }
      />

      {reached.length > 0 && (
        <form method="get" className={styles.filters}>
          <SelectField
            label="Namespace"
            name="namespace"
            defaultValue={namespace ?? ""}
            options={[
              { value: "", label: "All namespaces" },
              ...reached.map((ns) => ({ value: ns.metadata.name, label: ns.metadata.name })),
            ]}
          />
          <Button type="submit" variant="secondary">
            Show
          </Button>
        </form>
      )}

      {!namespaces.ok && <ErrorNotice error={namespaces.error} title="Couldn't list namespaces" />}

      {namespaces.ok && reached.length === 0 ? (
        <NoNamespaces />
      ) : (
        <ApplicationList namespace={namespace} namespaces={reached} canCreate={deployable.size > 0} />
      )}
    </>
  );
}
