/**
 * @file
 * One namespace: its capabilities, its Postgres, what it's using, and
 * its settings.
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Button } from "gui-mellow/Button";
import { Card } from "gui-mellow/Card";
import { Grid } from "gui-mellow/Grid";
import { StatusDot } from "gui-mellow/StatusDot";
import { Table } from "gui-mellow/Table";

import { CapabilitySwitch } from "@/components/CapabilitySwitch";
import { DetailList } from "@/components/DetailList";
import { ErrorNotice } from "@/components/ErrorNotice";
import { NamespaceSettingsForm } from "@/components/NamespaceSettingsForm";
import { PageHeader } from "@/components/PageHeader";
import styles from "@/components/page.module.scss";
import { CAPABILITIES, hasCapability } from "@/lib/capabilities";
import { getKube } from "@/lib/kube";
import { isNotFound, settle } from "@/lib/kube/client";
import type { PostgresCluster } from "@/lib/kube/types";
import {
  DEFAULT_SERVICE_ACCOUNT,
  PULL_SECRET_TYPE,
  SETTINGS_NAME,
  regionOf,
  toNamespaceForm,
} from "@/lib/namespace/settings";
import { POSTGRES_CLUSTER, POSTGRES_STORAGE } from "@/lib/postgres";

// What a quota's keys mean, in the order they're shown
const QUOTA_LABELS: Record<string, string> = {
  "requests.cpu": "CPU reserved",
  "limits.memory": "Memory",
  "requests.storage": "Storage",
};

/**
 * @param props
 * @param props.params
 * @returns
 */
export async function generateMetadata({ params }: { params: Promise<{ name: string }> }): Promise<Metadata> {
  return { title: decodeURIComponent((await params).name) };
}

/**
 * Whether CloudNativePG says a Cluster is up.
 *
 * @param cluster
 * @returns
 */
function postgresTone(cluster: PostgresCluster): "success" | "warning" {
  const ready = cluster.status?.readyInstances ?? 0;
  return ready > 0 && ready >= (cluster.spec?.instances ?? 1) ? "success" : "warning";
}

/**
 * @param props
 * @param props.params
 * @returns
 */
export default async function NamespacePage({ params }: { params: Promise<{ name: string }> }) {
  const name = decodeURIComponent((await params).name);
  const kube = await getKube();
  const found = await settle(() => kube.getNamespace(name));

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

  const namespace = found.value;
  const [quotas, limitRange, serviceAccount, secrets, clusters, apps, regions] = await Promise.all([
    settle(() => kube.listResourceQuotas(name)),
    settle(() => kube.getLimitRange(name, SETTINGS_NAME)),
    settle(() => kube.getServiceAccount(name, DEFAULT_SERVICE_ACCOUNT)),
    settle(() => kube.listSecrets(name)),
    settle(() => kube.listPostgresClusters(name)),
    settle(() => kube.listWebApplications(name)),
    settle(() => kube.listRegions()),
  ]);

  const ours = quotas.ok ? quotas.value.find((quota) => quota.metadata.name === SETTINGS_NAME) : undefined;
  const postgres = clusters.ok
    ? clusters.value.find((cluster) => cluster.metadata.name === POSTGRES_CLUSTER)
    : undefined;
  const usingPostgres = apps.ok ? apps.value.filter((app) => app.spec.postgres !== undefined) : [];
  const settingsReadable = quotas.ok && limitRange.ok && serviceAccount.ok;

  return (
    <>
      <PageHeader
        eyebrow="Namespace"
        title={name}
        back={{ href: "/namespaces", label: "Namespaces" }}
        actions={
          <>
            <Button href={`/apps?namespace=${encodeURIComponent(name)}`} variant="secondary">
              Applications
            </Button>
            <Button href={`/apps/new?namespace=${encodeURIComponent(name)}`}>New application</Button>
          </>
        }
      />

      <Grid min="300px" gap={5}>
        <Card title="Capabilities" level={2}>
          <DetailList
            items={CAPABILITIES.map((capability) => ({
              label: capability.title,
              value: (
                <CapabilitySwitch
                  namespace={name}
                  capability={capability.id}
                  enabled={hasCapability(namespace.metadata.labels, capability)}
                />
              ),
            }))}
          />
          <DetailList items={[{ label: "Region", value: regionOf(namespace.metadata.annotations) || "Anywhere" }]} />
        </Card>

        <Card title="Postgres" level={2}>
          {!clusters.ok ? (
            <ErrorNotice error={clusters.error} title="Couldn't look for it" />
          ) : postgres ? (
            <DetailList
              items={[
                {
                  label: "State",
                  value: (
                    <StatusDot tone={postgresTone(postgres)}>{postgres.status?.phase ?? "Not started yet"}</StatusDot>
                  ),
                },
                {
                  label: "Instances",
                  value: `${postgres.status?.readyInstances ?? 0} of ${postgres.spec?.instances ?? 1} ready`,
                },
                { label: "Volume", value: postgres.spec?.storage?.size },
                { label: "Host", value: <code>{`${POSTGRES_CLUSTER}-rw.${name}.svc`}</code> },
                {
                  label: "Databases for",
                  value: usingPostgres.map((app) => app.metadata.name).join(", ") || "No application yet",
                },
              ]}
            />
          ) : (
            <p className={styles.empty}>
              None yet. Cirrus starts <code>{POSTGRES_CLUSTER}</code>, with a {POSTGRES_STORAGE} volume, when the first
              application here asks for a database, and every later one shares it. It stays when the applications go.
            </p>
          )}
        </Card>

        {ours?.status?.hard && (
          <Card title="Using" level={2}>
            <DetailList
              items={Object.entries(QUOTA_LABELS)
                .filter(([key]) => ours.status?.hard?.[key] !== undefined)
                .map(([key, label]) => ({
                  label,
                  value: `${ours.status?.used?.[key] ?? "0"} of ${ours.status?.hard?.[key]}`,
                }))}
            />
          </Card>
        )}
      </Grid>

      {quotas.ok && quotas.value.some((quota) => quota.metadata.name !== SETTINGS_NAME) && (
        <section className={styles.section}>
          <h2 className={styles.heading}>Other quotas</h2>
          <p className={styles.empty}>Made outside Meteorologist, and left as they are. They apply too.</p>
          <Table
            columns={["Quota", "Limits"]}
            rows={quotas.value
              .filter((quota) => quota.metadata.name !== SETTINGS_NAME)
              .map((quota) => [
                quota.metadata.name,
                Object.entries(quota.spec?.hard ?? {})
                  .map(([key, value]) => `${key}=${value}`)
                  .join(", "),
              ])}
          />
        </section>
      )}

      <section className={styles.section}>
        <h2 className={styles.heading}>Settings</h2>
        {settingsReadable ? (
          <NamespaceSettingsForm
            initial={toNamespaceForm(
              name,
              namespace.metadata.annotations,
              ours,
              limitRange.value,
              serviceAccount.value,
            )}
            existing={{
              pullSecrets: secrets.ok
                ? secrets.value.filter((secret) => secret.type === PULL_SECRET_TYPE).map((secret) => secret.name)
                : [],
              hasPostgres: postgres !== undefined,
              storageUsed: ours?.status?.used?.["requests.storage"],
            }}
            regions={regions.ok ? regions.value : []}
          />
        ) : (
          <ErrorNotice
            error={[quotas, limitRange, serviceAccount].find((read) => !read.ok)?.error}
            title="Couldn't read this namespace's settings"
          />
        )}
      </section>
    </>
  );
}
