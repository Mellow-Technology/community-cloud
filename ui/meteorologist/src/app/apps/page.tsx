/**
 * @file
 * Every WebApplication, across namespaces or in one.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "gui-mellow/Button";
import { SelectField } from "gui-mellow/Field";
import { Table } from "gui-mellow/Table";
import { TagList } from "gui-mellow/Tag";

import { certificateCell } from "@/components/CertificateBadge";
import { ErrorNotice } from "@/components/ErrorNotice";
import { HealthBadge } from "@/components/HealthBadge";
import { PageHeader } from "@/components/PageHeader";
import styles from "@/components/page.module.scss";
import { getKube } from "@/lib/kube";
import { settle } from "@/lib/kube/client";
import { HEALTH_ORDER, appHealth } from "@/lib/webapp/health";
import { appHref, requestedServices, shownImage } from "@/lib/webapp/present";

export const metadata: Metadata = { title: "Applications" };

/**
 * @param props
 * @param props.searchParams
 * @returns
 */
export default async function AppsPage({ searchParams }: { searchParams: Promise<{ namespace?: string }> }) {
  const { namespace } = await searchParams;
  const kube = await getKube();
  const [apps, namespaces, certificates] = await Promise.all([
    settle(() => kube.listWebApplications(namespace || undefined)),
    settle(() => kube.listNamespaces()),
    settle(() => kube.listCertificates(namespace || undefined)),
  ]);

  return (
    <>
      <PageHeader
        eyebrow="Cirrus"
        title="Applications"
        description="WebApplications: an image, and what it needs to run, which Cirrus provides."
        actions={
          <Button href={namespace ? `/apps/new?namespace=${encodeURIComponent(namespace)}` : "/apps/new"}>
            New application
          </Button>
        }
      />

      {namespaces.ok && (
        <form method="get" className={styles.filters}>
          <SelectField
            label="Namespace"
            name="namespace"
            defaultValue={namespace ?? ""}
            options={[
              { value: "", label: "All namespaces" },
              ...namespaces.value.map((ns) => ({ value: ns.metadata.name, label: ns.metadata.name })),
            ]}
          />
          <Button type="submit" variant="secondary">
            Show
          </Button>
        </form>
      )}

      {!apps.ok ? (
        <ErrorNotice error={apps.error} title="Couldn't list applications" />
      ) : apps.value.length === 0 ? (
        <p className={styles.empty}>
          No applications {namespace ? `in ${namespace}` : "yet"}. <Link href="/apps/new">Create one</Link>.
        </p>
      ) : (
        <Table
          columns={[
            { label: "Name", sortable: true },
            { label: "Namespace", sortable: true },
            { label: "Health", sortable: true },
            ...(certificates.ok ? [{ label: "Certificate", sortable: true }] : []),
            "Image",
            "Address",
            "Uses",
          ]}
          rows={apps.value.map((app) => {
            const health = appHealth(app);
            return [
              { value: app.metadata.name, display: <Link href={appHref(app)}>{app.metadata.name}</Link> },
              app.metadata.namespace ?? "",
              { value: HEALTH_ORDER.indexOf(health.state), display: <HealthBadge health={health} /> },
              ...(certificates.ok ? [certificateCell(app, certificates.value)] : []),
              <span key="image" className={styles.mono}>
                {shownImage(app)}
              </span>,
              app.status?.url ? (
                <a key="url" href={app.status.url} target="_blank" rel="noreferrer">
                  {app.status.url.replace(/^https?:\/\//, "")}
                </a>
              ) : (
                ""
              ),
              <TagList key="uses" tags={requestedServices(app)} />,
            ];
          })}
        />
      )}
    </>
  );
}
