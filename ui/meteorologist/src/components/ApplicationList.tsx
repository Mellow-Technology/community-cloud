/**
 * @file
 * The table of WebApplications, across namespaces or in one, kept live.
 * Both the Applications page and a namespace's Applications tab show
 * it.
 */
import Link from "next/link";
import { Table } from "gui-mellow/Table";
import { TagList } from "gui-mellow/Tag";

import { certificateCell } from "@/components/CertificateBadge";
import { ErrorNotice } from "@/components/ErrorNotice";
import { HealthBadge } from "@/components/HealthBadge";
import { LiveRefresh } from "@/components/LiveRefresh";
import { PlaceholderTable } from "@/components/Placeholder";
import styles from "@/components/page.module.scss";
import { getKube } from "@/lib/kube";
import { settle } from "@/lib/kube/client";
import type { Namespace } from "@/lib/kube/types";
import { acrossNamespaces } from "@/lib/namespace/access";
import { FORGE_ORDER, forgeStatus } from "@/lib/webapp/forge";
import { HEALTH_ORDER, appHealth } from "@/lib/webapp/health";
import { appHref, requestedServices, shownImage } from "@/lib/webapp/present";

/**
 * @param props
 * @param props.namespace only this namespace's applications, read in one
 * @param props.namespaces otherwise, every namespace to read across
 * @param props.canCreate whether to offer making one when there are none
 * @param props.showNamespace whether to have a Namespace column; not
 *   worth one inside a namespace's own page
 * @returns
 */
export async function ApplicationList({
  namespace,
  namespaces = [],
  canCreate,
  showNamespace = true,
}: {
  namespace?: string;
  namespaces?: Namespace[];
  canCreate: boolean;
  showNamespace?: boolean;
}) {
  const kube = await getKube();
  // One namespace is one read; all of them may have to be several
  const across = <T,>(read: (namespace?: string) => Promise<T[]>) =>
    settle(() => (namespace ? read(namespace) : acrossNamespaces(namespaces, read)));
  const [apps, certificates] = await Promise.all([
    across((each) => kube.listWebApplications(each)),
    across((each) => kube.listCertificates(each)),
  ]);
  const newHref = namespace ? `/apps/new?namespace=${encodeURIComponent(namespace)}` : "/apps/new";

  return (
    <>
      <LiveRefresh namespace={namespace || undefined} />

      {!apps.ok ? (
        <ErrorNotice error={apps.error} title="Couldn't list applications" />
      ) : apps.value.length === 0 ? (
        <p className={styles.empty}>
          No applications {namespace ? `in ${namespace}` : "yet"}.{" "}
          {canCreate && (
            <>
              <Link href={newHref}>Create one</Link>.
            </>
          )}
        </p>
      ) : (
        <Table
          columns={[
            { label: "Name", sortable: true },
            ...(showNamespace ? [{ label: "Namespace", sortable: true }] : []),
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
              ...(showNamespace ? [app.metadata.namespace ?? ""] : []),
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

/**
 * The list as it will look, while it's still being read: its columns,
 * with placeholder rows.
 *
 * @param props
 * @param props.showNamespace as for the list
 * @returns
 */
export function ApplicationListPlaceholder({ showNamespace = true }: { showNamespace?: boolean }) {
  return (
    <PlaceholderTable
      label="Loading applications"
      columns={[
        "Name",
        ...(showNamespace ? ["Namespace"] : []),
        "Health",
        "Forge status",
        "Certificate",
        "Image",
        "Address",
        "Uses",
      ]}
    />
  );
}
