/**
 * @file
 * One WebApplication: how it's doing and why, what it's running, and
 * what it asked for.
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Disclosure } from "gui-mellow/Accordion";
import { Alert } from "gui-mellow/Alert";
import { Button } from "gui-mellow/Button";
import { Card } from "gui-mellow/Card";
import { CodeBlock } from "gui-mellow/CodeBlock";
import { Grid } from "gui-mellow/Grid";
import { StatusDot } from "gui-mellow/StatusDot";
import { Table } from "gui-mellow/Table";
import { TagList } from "gui-mellow/Tag";
import { stringify } from "yaml";

import { DetailList } from "@/components/DetailList";
import { ErrorNotice } from "@/components/ErrorNotice";
import { HealthBadge } from "@/components/HealthBadge";
import { PageHeader } from "@/components/PageHeader";
import styles from "@/components/page.module.scss";
import { getKube } from "@/lib/kube";
import { isNotFound, settle } from "@/lib/kube/client";
import { POSTGRES_CLUSTER, postgresDatabase } from "@/lib/postgres";
import { appHealth } from "@/lib/webapp/health";
import { requestedServices, specImage } from "@/lib/webapp/present";

interface Params {
  namespace: string;
  name: string;
}

/**
 * @param props
 * @param props.params
 * @returns
 */
export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { name } = await params;
  return { title: decodeURIComponent(name) };
}

/**
 * A timestamp, readably, or nothing.
 *
 * @param iso
 * @returns
 */
function when(iso: string | undefined): string | undefined {
  return iso
    ? new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) + " UTC"
    : undefined;
}

/**
 * @param props
 * @param props.params
 * @returns
 */
export default async function AppPage({ params }: { params: Promise<Params> }) {
  const { namespace, name } = await params;
  const kube = await getKube();
  const found = await settle(() => kube.getWebApplication(decodeURIComponent(namespace), decodeURIComponent(name)));

  if (!found.ok) {
    if (isNotFound(found.error)) {
      notFound();
    }
    return (
      <>
        <PageHeader title={decodeURIComponent(name)} back={{ href: "/apps", label: "Applications" }} />
        <ErrorNotice error={found.error} title="Couldn't read this application" />
      </>
    );
  }

  const app = found.value;
  const health = appHealth(app);
  const status = app.status;
  const gitlab = app.spec.source?.gitlab;
  const editHref = `/apps/${namespace}/${name}/edit`;

  return (
    <>
      <PageHeader
        eyebrow={app.metadata.namespace}
        title={app.metadata.name}
        back={{ href: "/apps", label: "Applications" }}
        actions={
          <>
            {status?.url && (
              <Button href={status.url} variant="secondary" target="_blank" rel="noreferrer">
                Open
              </Button>
            )}
            <Button href={editHref}>Edit</Button>
          </>
        }
      />

      <Alert tone={health.tone} title={<HealthBadge health={health} />} className={styles.stats}>
        {health.message}
      </Alert>

      <Grid min="320px" gap={5}>
        <Card title="Running" level={2}>
          <DetailList
            items={[
              { label: "Address", value: status?.url && <a href={status.url}>{status.url}</a> },
              { label: "Running", value: status?.deployedImage && <code>{status.deployedImage}</code> },
              { label: "Spec image", value: <code>{specImage(app)}</code> },
              {
                label: "Latest release",
                value: status?.release && (
                  <>
                    <code>{status.release.tag}</code> from commit <code>{status.release.commit.slice(0, 12)}</code>
                  </>
                ),
              },
              { label: "Migration job", value: status?.migrationJob && <code>{status.migrationJob}</code> },
              { label: "Replicas", value: String(app.spec.replicas ?? 1) },
              { label: "Port", value: String(app.spec.port ?? 8080) },
              { label: "Health check", value: app.spec.healthCheck?.path && <code>{app.spec.healthCheck.path}</code> },
              { label: "Last checked", value: when(status?.lastChecked) },
            ]}
          />
        </Card>

        <Card title="Asks for" level={2}>
          <DetailList
            items={[
              {
                label: "Services",
                value: requestedServices(app).length > 0 ? <TagList tags={requestedServices(app)} /> : "Nothing shared",
              },
              {
                label: "Hostnames",
                value: app.spec.hostnames?.length ? <TagList tags={app.spec.hostnames} /> : undefined,
              },
              {
                label: "Database",
                value:
                  app.spec.postgres === undefined ? undefined : (
                    <>
                      <code>{postgresDatabase(app.metadata.name)}</code>, its own, on {namespace}&apos;s shared Postgres
                      server, <code>{POSTGRES_CLUSTER}</code>
                    </>
                  ),
              },
              { label: "Bucket quota", value: app.spec.bucket?.quota },
              {
                label: "Source",
                value: gitlab && (
                  <>
                    <code>{gitlab.project}</code> at <code>{gitlab.ref ?? "main"}</code> on{" "}
                    {gitlab.url ?? "https://gitlab.com"}
                  </>
                ),
              },
              { label: "Webhook", value: status?.webhook && <code>{status.webhook.url}</code> },
              {
                label: "Connection secrets",
                value: [
                  app.spec.postgres !== undefined && `${app.metadata.name}-postgres`,
                  app.spec.rabbitmq !== undefined && `${app.metadata.name}-rabbitmq`,
                ]
                  .filter(Boolean)
                  .join(", "),
              },
            ]}
          />
        </Card>
      </Grid>

      <section className={styles.section}>
        <h2 className={styles.heading}>Conditions</h2>
        {status?.conditions?.length ? (
          <Table
            columns={["Condition", "Status", "Reason", "Message", "Since"]}
            rows={status.conditions.map((condition) => [
              condition.type,
              <StatusDot
                key="status"
                tone={condition.status === "True" ? "success" : condition.status === "False" ? "danger" : "neutral"}
              >
                {condition.status}
              </StatusDot>,
              condition.reason ?? "",
              condition.message ?? "",
              when(condition.lastTransitionTime) ?? "",
            ])}
          />
        ) : (
          <p className={styles.empty}>Cirrus hasn&apos;t reported any conditions yet.</p>
        )}
      </section>

      <section className={styles.section}>
        <Disclosure title="The resource, as stored">
          <CodeBlock
            code={stringify({
              apiVersion: app.apiVersion,
              kind: app.kind,
              metadata: { name: app.metadata.name, namespace: app.metadata.namespace },
              spec: app.spec,
            })}
            language="yaml"
            title="WebApplication"
          />
        </Disclosure>
      </section>
    </>
  );
}
