/**
 * @file
 * One WebApplication: how it's doing and why, what it's running, and
 * what it asked for.
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Disclosure } from "gui-mellow/Accordion";
import { Alert } from "gui-mellow/Alert";
import { Card } from "gui-mellow/Card";
import { CodeBlock } from "gui-mellow/CodeBlock";
import { Grid } from "gui-mellow/Grid";
import { StatusDot } from "gui-mellow/StatusDot";
import { Table } from "gui-mellow/Table";
import { TagList } from "gui-mellow/Tag";
import { stringify } from "yaml";

import { AppActions } from "@/components/AppActions";
import { DetailList } from "@/components/DetailList";
import { CertificateBadge } from "@/components/CertificateBadge";
import { ErrorNotice } from "@/components/ErrorNotice";
import { HealthBadge } from "@/components/HealthBadge";
import { LiveRefresh } from "@/components/LiveRefresh";
import { PageHeader } from "@/components/PageHeader";
import { ProjectBuild } from "@/components/ProjectBuild";
import styles from "@/components/page.module.scss";
import { getPublicUrl } from "@/lib/config";
import { BUILDS_CONFIG_MAP, buildSettingsFrom, includeUrl } from "@/lib/gitlab/builds";
import { getKube } from "@/lib/kube";
import { describeError, isNotFound, settle } from "@/lib/kube/client";
import { POSTGRES_CLUSTER, postgresDatabase } from "@/lib/postgres";
import { certificateStatus, findCertificate } from "@/lib/webapp/certificate";
import { deletionSummary } from "@/lib/webapp/deletion";
import { forgeStatus } from "@/lib/webapp/forge";
import { appHealth } from "@/lib/webapp/health";
import { portLabel, requestedServices, specImage } from "@/lib/webapp/present";
import { GROUP, PLURAL, STORAGE_TYPES, type StorageType } from "@/lib/webapp/types";

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
 * A storage type as people read it.
 *
 * @param type
 * @returns
 */
function storageLabel(type: StorageType | undefined): string {
  const found = STORAGE_TYPES.find((each) => each.value === (type ?? "fast"));
  if (found === undefined) {
    return String(type);
  }
  return found.storageClass ? `${found.value} (${found.storageClass})` : "a RAM disk, emptied on restart";
}

/**
 * @param props
 * @param props.params
 * @returns
 */
export default async function AppPage({ params }: { params: Promise<Params> }) {
  const { namespace, name } = await params;
  const kube = await getKube();
  const allowed = (verb: string) =>
    kube.canI({ verb, resource: PLURAL, group: GROUP, namespace: decodeURIComponent(namespace) }).catch(() => false);
  const [found, certificates, builds, canEdit, canDelete] = await Promise.all([
    settle(() => kube.getWebApplication(decodeURIComponent(namespace), decodeURIComponent(name))),
    settle(() => kube.listCertificates(decodeURIComponent(namespace))),
    settle(() => kube.getConfigMap(decodeURIComponent(namespace), BUILDS_CONFIG_MAP)),
    allowed("update"),
    allowed("delete"),
  ]);

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
  const forge = forgeStatus(app);
  const certificate = certificates.ok ? certificateStatus(app, findCertificate(app, certificates.value)) : undefined;
  const status = app.status;
  const gitlab = app.spec.source?.gitlab;
  const editHref = `/apps/${namespace}/${name}/edit`;
  const buildSettings = builds.ok ? buildSettingsFrom(builds.value) : undefined;
  const appNamespace = app.metadata.namespace ?? decodeURIComponent(namespace);

  return (
    <>
      <PageHeader
        eyebrow={app.metadata.namespace}
        title={app.metadata.name}
        back={{ href: "/apps", label: "Applications" }}
        actions={
          <AppActions
            namespace={app.metadata.namespace ?? decodeURIComponent(namespace)}
            name={app.metadata.name}
            url={status?.url}
            editHref={editHref}
            summary={deletionSummary(app)}
            deleting={health.state === "deleting"}
            canEdit={canEdit}
            canDelete={canDelete}
          />
        }
      />

      <LiveRefresh namespace={app.metadata.namespace ?? decodeURIComponent(namespace)} name={app.metadata.name} />

      <Alert tone={health.tone} title={<HealthBadge health={health} />} className={styles.stats}>
        {health.message}
      </Alert>

      <Grid min="320px" gap={5}>
        <Card title="Running" level={2}>
          <DetailList
            items={[
              { label: "Address", value: status?.url && <a href={status.url}>{status.url}</a> },
              {
                label: "Certificate",
                value: !app.spec.hostnames?.length ? undefined : !certificates.ok ? (
                  describeError(certificates.error)
                ) : (
                  <>
                    <CertificateBadge status={certificate} />
                    {certificate?.message && <span className={styles.detail}>{certificate.message}</span>}
                  </>
                ),
              },
              { label: "Running", value: status?.deployedImage && <code>{status.deployedImage}</code> },
              { label: "Spec image", value: <code>{specImage(app)}</code> },
              {
                label: "Forge status",
                value: forge && (
                  <>
                    <HealthBadge health={forge} />
                    {forge.message && <span className={styles.detail}>{forge.message}</span>}
                  </>
                ),
              },
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
              { label: "Port", value: portLabel(app) },
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
                label: "Volumes",
                value: app.spec.volumes?.length ? (
                  <>
                    {app.spec.volumes.map((volume) => (
                      <span key={volume.name} className={styles.detail}>
                        <code>{volume.mountPath}</code>: {volume.size}, {storageLabel(volume.type)}
                        {volume.type !== "ram" && (
                          <>
                            , in{" "}
                            <code>
                              {app.metadata.name}-{volume.name}
                            </code>
                          </>
                        )}
                      </span>
                    ))}
                  </>
                ) : undefined,
              },
              {
                label: "Source",
                value: gitlab && (
                  <>
                    <code>{gitlab.project}</code> at <code>{gitlab.ref ?? "main"}</code> on{" "}
                    {gitlab.url ?? "https://gitlab.com"}
                  </>
                ),
              },
              {
                label: "Image tag",
                value:
                  gitlab && (gitlab.imageTag !== undefined ? <code>{gitlab.imageTag}</code> : "Found from the commit"),
              },
              {
                label: "Push time fallback",
                value: gitlab?.findImageByPushTime
                  ? "On: the image pushed while the pipeline ran, if none is found by tag"
                  : undefined,
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

      {gitlab &&
        (builds.ok ? (
          <ProjectBuild
            namespace={appNamespace}
            project={gitlab.project}
            own={buildSettings?.projects[gitlab.project.toLowerCase()] ?? {}}
            namespaceBuild={buildSettings?.build ?? {}}
            urls={
              buildSettings && {
                dockerfile: includeUrl(getPublicUrl(), "dockerfile", appNamespace, buildSettings.key, gitlab.project),
                bake: includeUrl(getPublicUrl(), "bake", appNamespace, buildSettings.key, gitlab.project),
              }
            }
            imageTag={gitlab.imageTag}
          />
        ) : (
          <section className={styles.section}>
            <h2 className={styles.heading}>Building on GitLab CI</h2>
            <ErrorNotice error={builds.error} title="Couldn't read this namespace's GitLab build settings" />
          </section>
        ))}

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
