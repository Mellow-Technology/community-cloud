/**
 * @file
 * The landing page: how the cluster and the applications are doing, each of them
 * worst first, and the way to everything else.
 */
import Link from "next/link";
import { Badge } from "gui-mellow/Badge";
import { Button } from "gui-mellow/Button";
import { Card } from "gui-mellow/Card";
import { Grid } from "gui-mellow/Grid";
import { Stat } from "gui-mellow/Stat";
import { Table } from "gui-mellow/Table";

import { ErrorNotice } from "@/components/ErrorNotice";
import { certificateCell } from "@/components/CertificateBadge";
import { ClusterPanel } from "@/components/ClusterPanel";
import { HealthBadge } from "@/components/HealthBadge";
import { PageHeader } from "@/components/PageHeader";
import { CAPABILITIES, hasCapability } from "@/lib/capabilities";
import { getKube } from "@/lib/kube";
import { settle } from "@/lib/kube/client";
import { HEALTH_ORDER, appHealth, countHealth, presentHealth } from "@/lib/webapp/health";
import { appHref } from "@/lib/webapp/present";
import styles from "@/components/page.module.scss";

/**
 * @returns
 */
export default async function OverviewPage() {
  const kube = await getKube();
  const [namespaces, apps, certificates, usage] = await Promise.all([
    settle(() => kube.listNamespaces()),
    settle(() => kube.listWebApplications()),
    settle(() => kube.listCertificates()),
    settle(() => kube.getClusterUsage()),
  ]);

  const counts = apps.ok ? countHealth(apps.value) : undefined;
  const total = apps.ok ? apps.value.length : undefined;
  // Worst first, so what needs looking at is at the top
  const listed = apps.ok
    ? apps.value
        .map((app) => ({ app, health: appHealth(app) }))
        .sort((a, b) => HEALTH_ORDER.indexOf(a.health.state) - HEALTH_ORDER.indexOf(b.health.state))
    : [];

  return (
    <>
      <PageHeader
        eyebrow="Community Cloud"
        title="Overview"
        description="Your applications, and the namespaces they live in."
        actions={<Button href="/apps/new">New application</Button>}
      />

      <Grid min="180px" gap={4} className={styles.stats}>
        <Stat label="Applications" value={total ?? "—"} />
        <Stat label="Healthy" value={counts?.healthy ?? "—"} total={total} separator="of" />
        <Stat label="Need attention" value={counts && total !== undefined ? total - counts.healthy : "—"} />
        <Stat label="Namespaces" value={namespaces.ok ? namespaces.value.length : "—"} />
      </Grid>

      {!apps.ok && <ErrorNotice error={apps.error} title="Couldn't list applications" />}

      <ClusterPanel usage={usage} />

      {counts && (
        <section className={styles.section}>
          <h2 className={styles.heading}>Health</h2>
          <ul className={styles.healthRow}>
            {HEALTH_ORDER.map((state) => {
              const { tone, label } = presentHealth(state);
              return (
                <li key={state}>
                  <Badge tone={tone} dot uppercase={false}>
                    {label} <span className={styles.count}>{counts[state]}</span>
                  </Badge>
                </li>
              );
            })}
          </ul>

          {listed.length === 0 ? (
            <p className={styles.empty}>
              No applications yet. <Link href="/apps/new">Create one</Link>.
            </p>
          ) : (
            <Table
              columns={[
                { label: "Application", sortable: true },
                { label: "Namespace", sortable: true },
                { label: "Health", sortable: true },
                ...(certificates.ok ? [{ label: "Certificate", sortable: true }] : []),
                "Why",
              ]}
              rows={listed.map(({ app, health }) => [
                { value: app.metadata.name, display: <Link href={appHref(app)}>{app.metadata.name}</Link> },
                app.metadata.namespace ?? "",
                { value: HEALTH_ORDER.indexOf(health.state), display: <HealthBadge health={health} /> },
                ...(certificates.ok ? [certificateCell(app, certificates.value)] : []),
                health.message ?? "",
              ])}
            />
          )}
        </section>
      )}

      <section className={styles.section}>
        <h2 className={styles.heading}>Go to</h2>
        <Grid min="240px" gap={4}>
          <Card title="Applications" href="/apps" footer="All applications →">
            Every WebApplication you can see, with its health, image and address. Create one with the guided setup.
          </Card>
          <Card title="Namespaces" href="/namespaces" footer="Namespaces →">
            {namespaces.ok
              ? CAPABILITIES.map(
                  (capability) =>
                    `${namespaces.value.filter((ns) => hasCapability(ns.metadata.labels, capability)).length} with ${capability.title.toLowerCase()}`,
                ).join(", ") + ". "
              : ""}
            Turn on what each namespace may use.
          </Card>
          <Card title="Office" href="/office" footer="Office →">
            The applications installed for the cluster&apos;s people, how each is signed in to, and, for cluster admins,
            the administrator passwords.
          </Card>
          <Card title="New application" href="/apps/new" footer="Start →">
            Run an image with a database, a bucket or a queue, served on your own hostname and updated from GitLab.
          </Card>
        </Grid>
      </section>

      {!namespaces.ok && <ErrorNotice error={namespaces.error} title="Couldn't list namespaces" />}
    </>
  );
}
