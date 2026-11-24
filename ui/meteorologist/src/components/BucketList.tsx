/**
 * @file
 * The overview of buckets, across namespaces or in one: how many,
 * how full, and a table of each.
 */
import Link from "next/link";
import { Grid } from "gui-mellow/Grid";
import { Meter, Stat } from "gui-mellow/Stat";
import { Table } from "gui-mellow/Table";
import { TagList } from "gui-mellow/Tag";

import { ErrorNotice } from "@/components/ErrorNotice";
import { HealthBadge } from "@/components/HealthBadge";
import styles from "@/components/page.module.scss";
import { getKube } from "@/lib/kube";
import { settle } from "@/lib/kube/client";
import type { Namespace } from "@/lib/kube/types";
import { acrossNamespaces } from "@/lib/namespace/access";
import { formatBytes } from "@/lib/quantity";
import {
  BUCKET_PHASE_ORDER,
  bucketHealth,
  bucketHref,
  bucketManager,
  bucketName,
  bucketUsage,
  storageTotals,
} from "@/lib/storage/present";

/**
 * @param props
 * @param props.namespace only this namespace's buckets, read in one
 * @param props.namespaces otherwise, every namespace to read across
 * @param props.canCreate whether to offer making one when there are none
 * @param props.showNamespace whether to have a Namespace column
 * @returns
 */
export async function BucketList({
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
  const buckets = await settle(() =>
    namespace ? kube.listBuckets(namespace) : acrossNamespaces(namespaces, (each) => kube.listBuckets(each)),
  );
  const newHref = namespace ? `/storage/new?namespace=${encodeURIComponent(namespace)}` : "/storage/new";

  if (!buckets.ok) {
    return <ErrorNotice error={buckets.error} title="Couldn't list buckets" />;
  }
  if (buckets.value.length === 0) {
    return (
      <p className={styles.empty}>
        No buckets {namespace ? `in ${namespace}` : "yet"}.{" "}
        {canCreate && (
          <>
            <Link href={newHref}>Create one</Link>.
          </>
        )}
      </p>
    );
  }

  const totals = storageTotals(buckets.value);
  const sorted = buckets.value.toSorted(
    (a, b) =>
      (a.metadata.namespace ?? "").localeCompare(b.metadata.namespace ?? "") ||
      a.metadata.name.localeCompare(b.metadata.name),
  );

  return (
    <>
      <div className={styles.stats}>
        <Grid min="180px" gap={4}>
          <Stat label="Buckets ready" value={totals.ready} total={totals.buckets} meter={false} />
          <Stat
            label="Stored"
            value={formatBytes(totals.usedBytes)}
            total={totals.quotaBytes > 0 ? formatBytes(totals.quotaBytes) : undefined}
            separator={totals.quotaBytes > 0 ? "of quotas" : undefined}
          />
          <Stat label="Objects" value={totals.objects.toLocaleString("en")} />
        </Grid>
      </div>

      <Table
        columns={[
          { label: "Name", sortable: true },
          ...(showNamespace ? [{ label: "Namespace", sortable: true }] : []),
          { label: "Status", sortable: true },
          { label: "Used", sortable: true },
          { label: "Objects", sortable: true },
          "Versioning",
          "Access",
          "Looked after by",
        ]}
        rows={sorted.map((bucket) => {
          const health = bucketHealth(bucket);
          const usage = bucketUsage(bucket);
          const manager = bucketManager(bucket);
          const name = bucketName(bucket);
          return [
            {
              value: bucket.metadata.name,
              display: (
                <>
                  <Link href={bucketHref(bucket)}>{bucket.metadata.name}</Link>
                  {name !== bucket.metadata.name && <span className={styles.detail}>{name} in SeaweedFS</span>}
                </>
              ),
            },
            ...(showNamespace ? [bucket.metadata.namespace ?? ""] : []),
            { value: BUCKET_PHASE_ORDER.indexOf(health.state), display: <HealthBadge health={health} /> },
            {
              value: usage.usedBytes ?? -1,
              display: (
                <>
                  {usage.text}
                  {usage.fraction !== undefined && (
                    <Meter value={usage.fraction} label={`${bucket.metadata.name} used of its quota`} />
                  )}
                </>
              ),
            },
            { value: usage.objects ?? -1, display: usage.objects?.toLocaleString("en") ?? "" },
            bucket.status?.versioning ?? bucket.spec.versioning ?? "Off",
            <TagList
              key="access"
              tags={[
                ...(bucket.spec.access ?? []).map((each) => each.user),
                ...(bucket.spec.anonymousRead ? ["anyone, to read"] : []),
              ]}
            />,
            manager === undefined ? (
              ""
            ) : manager.href ? (
              <Link key="manager" href={manager.href}>
                {manager.name}
              </Link>
            ) : manager.kind === "installer" ? (
              "The installer"
            ) : (
              (manager.name ?? "")
            ),
          ];
        })}
      />
    </>
  );
}
