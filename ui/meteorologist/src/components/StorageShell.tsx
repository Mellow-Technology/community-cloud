/**
 * @file
 * What every Storage tab has around it: the header, the namespace
 * filter, and the tabs. Each tab's page reads what it needs and passes
 * its content in.
 */
import type { ReactNode } from "react";
import { Button } from "gui-mellow/Button";
import { SelectField } from "gui-mellow/Field";

import { ErrorNotice } from "@/components/ErrorNotice";
import { NoNamespaces } from "@/components/NoNamespaces";
import { PageHeader } from "@/components/PageHeader";
import { StorageTabs } from "@/components/StorageTabs";
import styles from "@/components/page.module.scss";
import type { Settled } from "@/lib/kube/client";
import type { Namespace } from "@/lib/kube/types";
import type { StorageTab } from "@/lib/storage/tabs";

/**
 * @param props
 * @param props.tab
 * @param props.namespace the namespace being shown, if only one
 * @param props.namespaces the namespaces the person can see
 * @param props.actions what goes in the header for this tab
 * @param props.children the tab's content
 * @returns
 */
export function StorageShell({
  tab,
  namespace,
  namespaces,
  actions,
  children,
}: {
  tab: StorageTab;
  namespace?: string;
  namespaces: Settled<Namespace[]>;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const reached = namespaces.ok ? namespaces.value : [];
  return (
    <>
      <PageHeader
        eyebrow="SeaweedFS"
        title="Storage"
        description="S3 buckets in the cluster's SeaweedFS, and the users that may use them."
        actions={actions}
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
        <StorageTabs selected={tab} namespace={namespace}>
          {children}
        </StorageTabs>
      )}
    </>
  );
}
