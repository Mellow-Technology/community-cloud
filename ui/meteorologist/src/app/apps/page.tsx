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
import { LiveRefresh } from "@/components/LiveRefresh";
import { NoNamespaces } from "@/components/NoNamespaces";
import { PageHeader } from "@/components/PageHeader";
import styles from "@/components/page.module.scss";
import { getKube } from "@/lib/kube";
import { settle } from "@/lib/kube/client";
import { acrossNamespaces, namespacesAllowing, reachableNamespaces } from "@/lib/namespace/access";
import { FORGE_ORDER, forgeStatus } from "@/lib/webapp/forge";
import { HEALTH_ORDER, appHealth } from "@/lib/webapp/health";
import { appHref, requestedServices, shownImage } from "@/lib/webapp/present";
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
  // One namespace is one read; all of them may have to be several
  const across = <T,>(read: (namespace?: string) => Promise<T[]>) =>
    settle(() => (namespace ? read(namespace) : acrossNamespaces(reached, read)));
  const [apps, certificates, deployable] = await Promise.all([
    across((each) => kube.listWebApplications(each)),
    across((each) => kube.listCertificates(each)),
    namespacesAllowing(
      kube,
      { verb: "create", resource: PLURAL, group: GROUP },
      namespace ? [namespace] : reached.map((ns) => ns.metadata.name),
    ),
  ]);

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

      <LiveRefresh namespace={namespace || undefined} />

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
      ) : !apps.ok ? (
        <ErrorNotice error={apps.error} title="Couldn't list applications" />
      ) : apps.value.length === 0 ? (
        <p className={styles.empty}>
          No applications {namespace ? `in ${namespace}` : "yet"}.{" "}
          {deployable.size > 0 && (
            <>
              <Link href="/apps/new">Create one</Link>.
            </>
          )}
        </p>
      ) : (
        <Table
          columns={[
            { label: "Name", sortable: true },
            { label: "Namespace", sortable: true },
            { label: "Health", sortable: true },
            { label: "Forge status", sortable: true },
            ...(certificates.ok ? [{ label: "Certificate", sortable: true }] : []),
            "Image",
            "Address",
            "Uses",
          ]}
          rows={apps.value.map((app) => {
            const health = appHealth(app);
            const forge = forgeStatus(app);
            return [
              { value: app.metadata.name, display: <Link href={appHref(app)}>{app.metadata.name}</Link> },
              app.metadata.namespace ?? "",
              { value: HEALTH_ORDER.indexOf(health.state), display: <HealthBadge health={health} /> },
              // Applications with no forge sort after every state
              forge
                ? { value: FORGE_ORDER.indexOf(forge.state), display: <HealthBadge health={forge} /> }
                : { value: FORGE_ORDER.length, display: "" },
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
