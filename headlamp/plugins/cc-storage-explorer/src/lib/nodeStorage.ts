/**
 * @file
 * How full a node's own disks are.
 *
 * The Node object says how big a node's disk is and nothing about how
 * much of it is in use: `status.capacity` carries `ephemeral-storage`,
 * and `status.allocatable` carries whatever is left of it after the
 * system's reservation. Neither moves when a pod fills the disk up.
 *
 * The usage is only in the kubelet's own summary, reached through the
 * API server at `/api/v1/nodes/<name>/proxy/stats/summary`. That needs
 * the `nodes/proxy` resource in RBAC, which plenty of clusters do not
 * hand out, so every view here has to work without it: the capacity
 * from the Node object is still worth showing, and a gauge that cannot
 * be drawn says why rather than reading as an empty disk.
 *
 * The one thing not done here is guessing. Capacity minus allocatable
 * is a real number and it is not usage — it is the reservation — and
 * drawing it in a usage gauge would be a confident lie.
 */
import { ApiProxy, K8s } from '@kinvolk/headlamp-plugin/lib';
import { useEffect, useState } from 'react';
import { buildNodeKey, readNodeKey } from './nodeNames';

export type NodeObject = InstanceType<typeof K8s.ResourceClasses.Node>;

// How often the kubelet summary is read again. The kubelet itself only
// recomputes these every ten seconds or so, so asking faster buys
// nothing and multiplies by the number of nodes.
export const REFRESH_INTERVAL_MS = 30000;

/**
 * What the kubelet summary API says about one filesystem.
 *
 * Everything is optional because a kubelet only reports what it knows:
 * a container runtime that shares one device for everything leaves
 * `imageFs` looking identical to the root filesystem, and a node that
 * has just started may have no inode counts yet.
 */
export interface KubeletFsStats {
  time?: string;
  availableBytes?: number;
  capacityBytes?: number;
  usedBytes?: number;
  inodesFree?: number;
  inodes?: number;
  inodesUsed?: number;
}

/**
 * One volume mounted into a pod, as the kubelet sees it.
 *
 * `pvcRef` is what makes these worth reading: it is the only place a
 * PersistentVolumeClaim's actual usage appears, since the claim itself
 * only records what was asked for.
 */
export interface KubeletVolumeStats extends KubeletFsStats {
  name?: string;
  pvcRef?: { name: string; namespace: string };
}

export interface KubeletPodStats {
  podRef?: { name: string; namespace: string; uid: string };
  volume?: KubeletVolumeStats[];
  'ephemeral-storage'?: KubeletFsStats;
}

export interface KubeletNodeSummary {
  node?: {
    nodeName?: string;
    fs?: KubeletFsStats;
    runtime?: { imageFs?: KubeletFsStats };
  };
  pods?: KubeletPodStats[];
}

/**
 * Everything the views need to draw one node's storage.
 *
 * The two halves come from different places and fail independently:
 * the filesystems from the kubelet, the capacities from the Node
 * object. `statsError` is set when only the second half arrived.
 */
export interface NodeStorage {
  nodeName: string;
  /** The filesystem the kubelet writes pod data to, which it calls nodefs. */
  rootFs?: KubeletFsStats;
  /** The filesystem holding container images, which it calls imagefs. */
  imageFs?: KubeletFsStats;
  /** True when imagefs and nodefs are one device, so one gauge says it all. */
  imageFsShared: boolean;
  /** `status.capacity['ephemeral-storage']`, in bytes. */
  capacityBytes?: number;
  /** `status.allocatable['ephemeral-storage']`, in bytes. */
  allocatableBytes?: number;
  /** Why the kubelet summary could not be read for this node. */
  statsError?: string;
}

export interface NodeSummariesResult {
  summaries: Record<string, KubeletNodeSummary>;
  errors: Record<string, string>;
  loading: boolean;
}

/**
 * What is said wherever a gauge cannot be drawn.
 *
 * Named rather than written out at each site, because a person who
 * sees it on one node's page and again on the overview should not have
 * to work out whether they are being told two different things.
 */
export const STATS_UNAVAILABLE_HINT =
  'Live usage comes from the kubelet summary API (nodes/proxy). Your user or the ' +
  'Headlamp service account may not be allowed to read it on this cluster.';

/**
 * Where a node's kubelet summary is served.
 *
 * @param nodeName
 * @returns
 */
function summaryPath(nodeName: string): string {
  return `/api/v1/nodes/${encodeURIComponent(nodeName)}/proxy/stats/summary`;
}

/**
 * Something readable out of whatever a failed request threw.
 *
 * The status code is kept because it is the part that tells a person
 * what to do: a 403 is a permission to grant, anything else is not.
 *
 * @param err
 * @returns
 */
function errorMessage(err: unknown): string {
  if (err && typeof err === 'object') {
    const maybeApiError = err as { status?: number; message?: string };
    if (maybeApiError.message) {
      return maybeApiError.status
        ? `${maybeApiError.message} (${maybeApiError.status})`
        : maybeApiError.message;
    }
  }

  return String(err);
}

/**
 * The kubelet summary of each of the given nodes, kept up to date.
 *
 * Failures are collected per node rather than raised, because one
 * unreachable kubelet should not empty the view of every other node —
 * and on a cluster without `nodes/proxy` every node fails, which is a
 * state the views are expected to render rather than an error.
 *
 * @param nodeNames
 * @returns
 */
export function useNodeSummaries(nodeNames: string[]): NodeSummariesResult {
  const cluster = K8s.useCluster();
  const nodeKey = buildNodeKey(nodeNames);
  const [summaries, setSummaries] = useState<Record<string, KubeletNodeSummary>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const names = readNodeKey(nodeKey);
    if (names.length === 0) {
      setSummaries({});
      setErrors({});
      setLoading(false);
      return;
    }

    let cancelled = false;

    async function fetchAll() {
      const results = await Promise.all(
        names.map(async name => {
          try {
            // autoLogoutOnAuthError is off: a cluster that will not
            // serve these is a view that degrades, not a session that
            // ends.
            const data: KubeletNodeSummary = await ApiProxy.request(
              summaryPath(name),
              { cluster },
              false
            );
            return { name, data, error: undefined };
          } catch (err) {
            return { name, data: undefined, error: errorMessage(err) };
          }
        })
      );

      if (cancelled) {
        return;
      }

      const nextSummaries: Record<string, KubeletNodeSummary> = {};
      const nextErrors: Record<string, string> = {};
      results.forEach(result => {
        if (result.error !== undefined) {
          nextErrors[result.name] = result.error;
        } else if (result.data) {
          nextSummaries[result.name] = result.data;
        }
      });

      setSummaries(nextSummaries);
      setErrors(nextErrors);
      setLoading(false);
    }

    setLoading(true);
    fetchAll();
    const intervalId = setInterval(fetchAll, REFRESH_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [nodeKey, cluster]);

  return { summaries, errors, loading };
}

/**
 * The same for a single node.
 *
 * @param nodeName
 * @returns
 */
export function useNodeSummary(nodeName?: string): {
  summary?: KubeletNodeSummary;
  error?: string;
  loading: boolean;
} {
  const { summaries, errors, loading } = useNodeSummaries(nodeName ? [nodeName] : []);

  return {
    summary: nodeName ? summaries[nodeName] : undefined,
    error: nodeName ? errors[nodeName] : undefined,
    loading,
  };
}

// The suffixes a Kubernetes quantity can carry, and what each one
// multiplies by. The binary ones are what storage is actually written
// in; the decimal ones are accepted because the API will take them.
const QUANTITY_MULTIPLIERS: Record<string, number> = {
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
  Pi: 1024 ** 5,
  Ei: 1024 ** 6,
  K: 1000,
  k: 1000,
  M: 1000 ** 2,
  G: 1000 ** 3,
  T: 1000 ** 4,
  P: 1000 ** 5,
  E: 1000 ** 6,
  m: 1e-3,
  u: 1e-6,
  n: 1e-9,
};

/**
 * A Kubernetes quantity such as `61255492Ki` or `1.5Gi`, in bytes.
 *
 * Headlamp has `parseDiskSpace` for this, but it reads the number with
 * `parseInt` and so quietly turns "1.5Gi" into one gibibyte. Node
 * capacities are whole numbers of kibibytes and would survive that;
 * volume sizes are written by people and do not.
 *
 * Undefined rather than zero for anything unparseable, so that a
 * quantity in a form not handled here reads as a number nobody has
 * instead of a disk of no size.
 *
 * @param quantity
 * @returns
 */
export function parseStorageQuantity(quantity?: string | number | null): number | undefined {
  if (quantity === undefined || quantity === null || quantity === '') {
    return undefined;
  }
  if (typeof quantity === 'number') {
    return quantity;
  }

  const match = /^([0-9.]+)([EPTGMK]i?|[munk])?$/.exec(quantity.trim());
  if (!match) {
    return undefined;
  }

  const value = Number(match[1]);
  if (Number.isNaN(value)) {
    return undefined;
  }

  return value * (match[2] ? QUANTITY_MULTIPLIERS[match[2]] ?? 1 : 1);
}

/**
 * Whether two sets of filesystem stats are the same device.
 *
 * The kubelet does not say which device a filesystem is on, so this
 * goes by size: two filesystems of identical capacity with identical
 * space left are, in practice, one filesystem reported twice.
 *
 * @param a
 * @param b
 * @returns
 */
function sameFilesystem(a?: KubeletFsStats, b?: KubeletFsStats): boolean {
  if (!a || !b) {
    return false;
  }

  return a.capacityBytes === b.capacityBytes && a.availableBytes === b.availableBytes;
}

/**
 * One node's storage, from its Node object and its kubelet summary.
 *
 * @param node
 * @param summary
 * @param statsError
 * @returns
 */
export function getNodeStorage(
  node: NodeObject,
  summary?: KubeletNodeSummary,
  statsError?: string
): NodeStorage {
  // The generated Node type spells these "ephemeralStorage", but the
  // key on the wire is "ephemeral-storage".
  const status = (node.jsonData.status ?? {}) as {
    capacity?: Record<string, string>;
    allocatable?: Record<string, string>;
  };
  const rootFs = summary?.node?.fs;
  const imageFs = summary?.node?.runtime?.imageFs;

  return {
    nodeName: node.getName(),
    rootFs,
    imageFs,
    imageFsShared: sameFilesystem(rootFs, imageFs),
    capacityBytes: parseStorageQuantity(status.capacity?.['ephemeral-storage']),
    allocatableBytes: parseStorageQuantity(status.allocatable?.['ephemeral-storage']),
    statsError,
  };
}

/**
 * What the node says about its own disk pressure.
 *
 * Unknown when there is no such condition, which is not the same as
 * healthy: a node that has stopped reporting is exactly the node worth
 * looking at.
 *
 * @param node
 * @returns
 */
export function getDiskPressure(node: NodeObject): 'ok' | 'pressure' | 'unknown' {
  const conditions = (node.jsonData.status?.conditions ?? []) as {
    type: string;
    status: string;
  }[];
  const condition = conditions.find(item => item.type === 'DiskPressure');

  if (!condition) {
    return 'unknown';
  }
  if (condition.status === 'True') {
    return 'pressure';
  }

  return condition.status === 'False' ? 'ok' : 'unknown';
}

/**
 * The volume stats in a summary, keyed by `namespace/name` of the claim.
 *
 * @param summary
 * @returns
 */
export function getVolumeStatsByClaim(
  summary?: KubeletNodeSummary
): Record<string, KubeletVolumeStats> {
  const byClaim: Record<string, KubeletVolumeStats> = {};

  summary?.pods?.forEach(pod => {
    pod.volume?.forEach(volume => {
      if (volume.pvcRef) {
        byClaim[`${volume.pvcRef.namespace}/${volume.pvcRef.name}`] = volume;
      }
    });
  });

  return byClaim;
}

export interface PodEphemeralUsage {
  name: string;
  namespace: string;
  usedBytes?: number;
  inodesUsed?: number;
}

/**
 * The pods on a node, by how much of its disk they are using.
 *
 * Sorted here rather than in the table because the answer people want
 * from this is "which pod is filling the disk", and that should be the
 * first row whether or not anyone has clicked a column heading.
 *
 * @param summary
 * @returns
 */
export function getPodEphemeralUsage(summary?: KubeletNodeSummary): PodEphemeralUsage[] {
  const pods = (summary?.pods ?? [])
    .filter(pod => !!pod.podRef)
    .map(pod => ({
      name: pod.podRef!.name,
      namespace: pod.podRef!.namespace,
      usedBytes: pod['ephemeral-storage']?.usedBytes,
      inodesUsed: pod['ephemeral-storage']?.inodesUsed,
    }));

  return pods.sort((a, b) => (b.usedBytes ?? 0) - (a.usedBytes ?? 0));
}
