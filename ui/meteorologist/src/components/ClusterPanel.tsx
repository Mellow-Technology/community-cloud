/**
 * @file
 * The cluster at a glance: how it's doing, then its CPU, memory, pods
 * and network, as the Community Cloud homepage shows them.
 *
 * Only someone who may read every node and pod sees it. For anyone
 * else the API server says 403, and the panel isn't drawn at all: it
 * would only ever be an error, and there's nothing they could do
 * about it.
 */
import { Grid } from "gui-mellow/Grid";
import { Stat } from "gui-mellow/Stat";
import { StatusDot } from "gui-mellow/StatusDot";

import { ErrorNotice } from "@/components/ErrorNotice";
import styles from "@/components/page.module.scss";
import { bytesIn, summarizeCluster, type ClusterUsage } from "@/lib/cluster";
import { isForbidden, type Settled } from "@/lib/kube/client";

/**
 * A figure with at most one decimal place, and none when it's whole.
 *
 * @param value
 * @returns
 */
function figure(value: number): string {
  return String(Number(value.toFixed(1)));
}

/**
 * @param props
 * @param props.usage what getClusterUsage found, or why it couldn't
 * @returns
 */
export function ClusterPanel({ usage }: { usage: Settled<ClusterUsage> }) {
  if (!usage.ok) {
    return isForbidden(usage.error) ? null : (
      <section className={styles.section}>
        <h2 className={styles.heading}>Cluster</h2>
        <ErrorNotice error={usage.error} title="Couldn't read the cluster's usage" />
      </section>
    );
  }

  const summary = summarizeCluster(usage.value);
  const memoryUsed = bytesIn(summary.memory.usedBytes, summary.memory.totalBytes);
  const memoryTotal = bytesIn(summary.memory.totalBytes);
  const rx = bytesIn(summary.network.rxBytes);
  const tx = bytesIn(summary.network.txBytes);

  return (
    <section className={styles.section}>
      <h2 className={styles.heading}>Cluster</h2>
      <p className={styles.clusterStatus}>
        <StatusDot tone={summary.tone}>{summary.label}</StatusDot>
        {summary.reasons.length > 0 && <span className={styles.detail}>{summary.reasons.join(". ")}.</span>}
        {summary.unreported.length > 0 && (
          <span className={styles.detail}>
            {summary.unreported.join(", ")} didn&apos;t report, so {summary.unreported.length === 1 ? "its" : "their"}{" "}
            usage isn&apos;t counted.
          </span>
        )}
      </p>
      <Grid min="180px" gap={4}>
        <Stat
          label="CPU"
          value={figure(summary.cpu.usedCores)}
          total={figure(summary.cpu.totalCores)}
          unit="cores"
          meter
        />
        <Stat
          label="Memory"
          value={figure(memoryUsed.value)}
          unit={memoryUsed.unit}
          total={figure(memoryTotal.value)}
          totalUnit={memoryTotal.unit}
          meter
        />
        <Stat label="Healthy pods" value={summary.pods.healthy} total={summary.pods.total} />
        <Stat
          label="Network"
          title="Bytes in and out of each node since it started, over the network between nodes"
          value={figure(rx.value)}
          unit={`${rx.unit} in`}
          total={figure(tx.value)}
          totalUnit={`${tx.unit} out`}
          separator="/"
          meter={false}
        />
      </Grid>
    </section>
  );
}
