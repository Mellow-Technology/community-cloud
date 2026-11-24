/**
 * @file
 * One SeaweedFS Bucket: how it's doing, how full it is, who may use it,
 * and how it's set up.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Disclosure } from "gui-mellow/Accordion";
import { Alert } from "gui-mellow/Alert";
import { Card } from "gui-mellow/Card";
import { CodeBlock } from "gui-mellow/CodeBlock";
import { Grid } from "gui-mellow/Grid";
import { Stat } from "gui-mellow/Stat";
import { StatusDot } from "gui-mellow/StatusDot";
import { Table } from "gui-mellow/Table";
import { stringify } from "yaml";

import { BucketActions } from "@/components/BucketActions";
import { DetailList } from "@/components/DetailList";
import { ErrorNotice } from "@/components/ErrorNotice";
import { HealthBadge } from "@/components/HealthBadge";
import { PageHeader } from "@/components/PageHeader";
import styles from "@/components/page.module.scss";
import { getKube } from "@/lib/kube";
import { isNotFound, settle } from "@/lib/kube/client";
import { formatBytes } from "@/lib/quantity";
import { bucketDeletion, bucketHealth, bucketManager, bucketName, bucketUsage } from "@/lib/storage/present";
import { BUCKET_GROUP, BUCKET_PLURAL } from "@/lib/storage/types";

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
export default async function BucketPage({ params }: { params: Promise<Params> }) {
  const { namespace: rawNamespace, name: rawName } = await params;
  const namespace = decodeURIComponent(rawNamespace);
  const name = decodeURIComponent(rawName);
  const kube = await getKube();
  const allowed = (verb: string) =>
    kube.canI({ verb, resource: BUCKET_PLURAL, group: BUCKET_GROUP, namespace }).catch(() => false);
  const [found, canEdit, canDelete] = await Promise.all([
    settle(() => kube.getBucket(namespace, name)),
    allowed("update"),
    allowed("delete"),
  ]);
  const back = { href: "/storage", label: "Storage" };

  if (!found.ok) {
    if (isNotFound(found.error)) {
      notFound();
    }
    return (
      <>
        <PageHeader title={name} back={back} />
        <ErrorNotice error={found.error} title="Couldn't read this bucket" />
      </>
    );
  }

  const bucket = found.value;
  const { spec, status } = bucket;
  const health = bucketHealth(bucket);
  const usage = bucketUsage(bucket);
  const manager = bucketManager(bucket);
  const placement = spec.placement ?? {};

  return (
    <>
      <PageHeader
        eyebrow={namespace}
        title={bucket.metadata.name}
        back={back}
        actions={
          <BucketActions
            namespace={namespace}
            name={bucket.metadata.name}
            editHref={`/storage/${rawNamespace}/${rawName}/edit`}
            summary={bucketDeletion(bucket)}
            deleting={health.state === "Terminating"}
            canEdit={canEdit}
            canDelete={canDelete}
          />
        }
      />

      <Alert tone={health.tone} title={<HealthBadge health={health} />} className={styles.stats}>
        {health.message ??
          (health.state === "Ready"
            ? `SeaweedFS has the bucket ${bucketName(bucket)}.`
            : "SeaweedFS's operator hasn't said how it's doing yet.")}
      </Alert>

      <div className={styles.stats}>
        <Grid min="180px" gap={4}>
          <Stat
            label="Stored"
            value={usage.usedBytes === undefined ? "Not counted" : formatBytes(usage.usedBytes)}
            total={usage.quotaBytes === undefined ? undefined : formatBytes(usage.quotaBytes)}
            separator={usage.quotaBytes === undefined ? undefined : "of"}
            meter={usage.fraction !== undefined}
          />
          <Stat label="Objects" value={usage.objects?.toLocaleString("en") ?? "Not counted"} />
          <Stat
            label="Quota"
            value={usage.quotaBytes === undefined ? "None" : formatBytes(usage.quotaBytes)}
            unit={
              usage.quotaBytes === undefined
                ? undefined
                : status?.quota?.enforced === false
                  ? "reported only"
                  : "enforced"
            }
          />
        </Grid>
      </div>

      <Grid min="320px" gap={5}>
        <Card title="Bucket" level={2}>
          <DetailList
            items={[
              { label: "In SeaweedFS", value: <code>{bucketName(bucket)}</code> },
              {
                label: "SeaweedFS",
                value: (
                  <code>
                    {spec.clusterRef.namespace ? `${spec.clusterRef.namespace}/` : ""}
                    {spec.clusterRef.name}
                  </code>
                ),
              },
              {
                label: "Looked after by",
                value:
                  manager === undefined ? undefined : manager.href ? (
                    <>
                      <Link href={manager.href}>{manager.name}</Link>, through Cirrus
                    </>
                  ) : manager.kind === "installer" ? (
                    "The installer"
                  ) : (
                    manager.name
                  ),
              },
              { label: "Owner", value: status?.ownerIdentity ?? spec.owner },
              { label: "Counted", value: when(status?.usage?.lastUpdated) },
              { label: "Made", value: when(bucket.metadata.creationTimestamp) },
            ]}
          />
        </Card>

        <Card title="Settings" level={2}>
          <DetailList
            items={[
              { label: "Versioning", value: status?.versioning ?? spec.versioning ?? "Off" },
              { label: "Object lock", value: (status?.objectLockEnabled ?? spec.objectLock) ? "On" : "Off" },
              { label: "Anyone may read", value: spec.anonymousRead ? "Yes, by name" : "No" },
              {
                label: "When deleted",
                value: spec.reclaimPolicy === "Delete" ? "The contents are deleted too" : "The contents are kept",
              },
              { label: "Replication", value: placement.replication && <code>{placement.replication}</code> },
              { label: "Time to live", value: placement.ttl },
              { label: "Disk type", value: placement.diskType },
              {
                label: "Placement",
                value: [placement.dataCenter, placement.rack, placement.dataNode].filter(Boolean).join(" / "),
              },
            ]}
          />
        </Card>
      </Grid>

      <section className={styles.section}>
        <h2 className={styles.heading}>Access</h2>
        {spec.access?.length ? (
          <Table
            columns={["User", "May"]}
            rows={spec.access.map((each) => [<code key="user">{each.user}</code>, each.actions.join(", ")])}
          />
        ) : (
          <p className={styles.empty}>No users are given access, beyond SeaweedFS&apos;s admins.</p>
        )}
      </section>

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
          <p className={styles.empty}>SeaweedFS&apos;s operator hasn&apos;t reported any conditions yet.</p>
        )}
      </section>

      <section className={styles.section}>
        <Disclosure title="The resource, as stored">
          <CodeBlock
            code={stringify({
              apiVersion: bucket.apiVersion,
              kind: bucket.kind,
              metadata: { name: bucket.metadata.name, namespace: bucket.metadata.namespace },
              spec,
            })}
            language="yaml"
            title="Bucket"
          />
        </Disclosure>
      </section>
    </>
  );
}
