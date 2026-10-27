/**
 * @file
 * The landing page: how the applications are doing, what needs
 * looking at, and the way to everything else.
 */
import Link from "next/link";
import { Button } from "gui-mellow/Button";
import { Card } from "gui-mellow/Card";
import { Grid } from "gui-mellow/Grid";
import { Stat } from "gui-mellow/Stat";
import { Table } from "gui-mellow/Table";

import { ErrorNotice } from "@/components/ErrorNotice";
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
  const [namespaces, apps] = await Promise.all([
    settle(() => kube.listNamespaces()),
    settle(() => kube.listWebApplications()),
  ]);

  const counts = apps.ok ? countHealth(apps.value) : undefined;
  const total = apps.ok ? apps.value.length : undefined;
  const attention = apps.ok
    ? apps.value
        .map((app) => ({ app, health: appHealth(app) }))
        .filter(({ health }) => health.state !== "healthy")
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

      {counts && (
        <section className={styles.section}>
          <h2 className={styles.heading}>Health</h2>
          <ul className={styles.healthRow}>
            {HEALTH_ORDER.map((state) => (
              <li key={state}>
                <HealthBadge health={{ state, ...presentHealth(state) }} />
                <span className={styles.count}>{counts[state]}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {attention.length > 0 && (
        <section className={styles.section}>
          <h2 className={styles.heading}>Needs attention</h2>
          <Table
            columns={["Application", "Namespace", "Health", "Why"]}
            rows={attention.map(({ app, health }) => [
              <Link key="name" href={appHref(app)}>
                {app.metadata.name}
              </Link>,
              app.metadata.namespace,
              <HealthBadge key="health" health={health} />,
              health.message ?? "",
            ])}
          />
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
          <Card title="New application" href="/apps/new" footer="Start →">
            Run an image with a database, a bucket or a queue, served on your own hostname and updated from GitLab.
          </Card>
        </Grid>
      </section>

      {!namespaces.ok && <ErrorNotice error={namespaces.error} title="Couldn't list namespaces" />}
    </>
  );
}
