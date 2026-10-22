/**
 * @file
 * The LVM volumes TopoLVM cuts out of a node's volume group.
 *
 * TopoLVM provisions each PersistentVolume as a logical volume on one
 * particular machine, and records what it did in a cluster-scoped
 * `LogicalVolume` custom resource. That resource is the only place two
 * things appear: which node the volume is on, and how big it actually
 * ended up being as opposed to how big it was asked to be.
 *
 * It is also the only place a volume shows up at all once its PV is
 * gone. Deleting a PV is supposed to take the logical volume with it,
 * but a PV removed while its finalizer could not run leaves the
 * LogicalVolume behind, still naming space in a volume group that
 * nothing will ever ask for again. Those are the ones worth finding, so
 * every volume here carries whether a PV still refers to it rather than
 * being quietly dropped when none does.
 *
 * Which classes a node can serve, and how the installer labels nodes
 * with them, is in the installer's own `src/util/storage.ts`.
 */
import { K8s } from '@kinvolk/headlamp-plugin/lib';
import { makeCustomResourceClass } from '@kinvolk/headlamp-plugin/lib/lib/k8s/crd';
import { useMemo } from 'react';
import { parseStorageQuantity } from './nodeStorage';

// The CRD's name, which is how Headlamp's own custom resource view is
// addressed.
export const LOGICAL_VOLUME_CRD = 'logicalvolumes.topolvm.io';

// Where TopoLVM annotates a node with the space left in each of its
// volume groups.
const CAPACITY_ANNOTATION_PREFIX = 'capacity.topolvm.io/';

// TopoLVM writes the node's default class twice: once under its own
// name and once under this. Reading both would count the same volume
// group's free space twice over.
const DEFAULT_DEVICE_CLASS_ANNOTATION = '00default';

export const LogicalVolumeClass = makeCustomResourceClass({
  apiInfo: [{ group: 'topolvm.io', version: 'v1' }],
  kind: 'LogicalVolume',
  singularName: 'logicalvolume',
  pluralName: 'logicalvolumes',
  isNamespaced: false,
});

export type LogicalVolumeObject = InstanceType<typeof LogicalVolumeClass>;

interface LogicalVolumeSpec {
  /** The name of the LVM logical volume. */
  name?: string;
  /** The node whose volume group holds it. */
  nodeName?: string;
  /** The size asked for, as a Kubernetes quantity. */
  size?: string;
  deviceClass?: string;
  lvcreateOptionClass?: string;
  accessType?: string;
  source?: string;
}

interface LogicalVolumeStatus {
  /** Set once the volume exists; the same value as the PV's CSI handle. */
  volumeID?: string;
  /** The size it actually has on the node. */
  currentSize?: string;
  /** The gRPC status code of the last failed operation. */
  code?: number;
  message?: string;
}

/**
 * The PersistentVolume using a logical volume.
 *
 * `matchedBy` is kept because the two ways of matching are not equally
 * certain, and the weaker one is worth saying out loud in the UI.
 */
export interface LogicalVolumeClaimant {
  name: string;
  phase: string;
  matchedBy: 'volumeID' | 'name';
  claim?: { name: string; namespace: string };
  storageClass?: string;
}

export interface LogicalVolume {
  logicalVolume: LogicalVolumeObject;
  name: string;
  nodeName?: string;
  /** True when `nodeName` is not a node of this cluster any more. */
  nodeMissing: boolean;
  deviceClass?: string;
  requestedBytes?: number;
  /** The size on the node. Absent until TopoLVM has created the volume. */
  currentBytes?: number;
  volumeID?: string;
  /** What TopoLVM reported about the last operation on this volume. */
  error?: { code?: number; message?: string };
  creationTimestamp?: string;
  /** The PersistentVolume using this volume, if one still does. */
  persistentVolume?: LogicalVolumeClaimant;
}

export interface LogicalVolumesResult {
  volumes: LogicalVolume[] | null;
  error: unknown;
  /** True when this cluster has no LogicalVolume resource to read. */
  crdMissing: boolean;
}

type PersistentVolumeObject = InstanceType<typeof K8s.ResourceClasses.PersistentVolume>;

/**
 * Whether a failure means there is nothing here to show.
 *
 * A cluster not running TopoLVM has no such resource and answers 404.
 * A user without the permission to list them gets a 403, which is a
 * different cause with the same remedy — say so plainly and show
 * nothing — so both are treated as the resource being absent and the
 * message covers the two.
 *
 * @param error
 * @returns
 */
function isAbsent(error: unknown): boolean {
  const status = (error as { status?: number } | null)?.status;

  return status === 404 || status === 403;
}

/**
 * The space left in each of a node's volume groups.
 *
 * These are the numbers that limit a new logical volume on that node.
 * They are not the numbers the Node Storage gauges show: those measure
 * the kubelet's root filesystem, which is a different disk.
 *
 * @param node
 * @returns
 */
export function getDeviceClassFreeBytes(node: {
  jsonData: { metadata?: { annotations?: Record<string, string> } };
}): Record<string, number> {
  const annotations = node.jsonData.metadata?.annotations ?? {};
  const free: Record<string, number> = {};

  Object.entries(annotations).forEach(([key, value]) => {
    if (!key.startsWith(CAPACITY_ANNOTATION_PREFIX)) {
      return;
    }

    const deviceClass = key.slice(CAPACITY_ANNOTATION_PREFIX.length);
    if (deviceClass === DEFAULT_DEVICE_CLASS_ANNOTATION) {
      return;
    }

    const bytes = Number(value);
    if (!Number.isNaN(bytes)) {
      free[deviceClass] = bytes;
    }
  });

  return free;
}

/**
 * A PersistentVolume as the thing using a logical volume.
 *
 * @param pv
 * @param matchedBy
 * @returns
 */
function describePersistentVolume(
  pv: PersistentVolumeObject,
  matchedBy: LogicalVolumeClaimant['matchedBy']
): LogicalVolumeClaimant {
  const spec = pv.spec as {
    claimRef?: { name?: string; namespace?: string };
    storageClassName?: string;
  };
  const claimRef = spec.claimRef;

  return {
    name: pv.getName(),
    phase: pv.status?.phase ?? 'Unknown',
    matchedBy,
    claim:
      claimRef?.name && claimRef?.namespace
        ? { name: claimRef.name, namespace: claimRef.namespace }
        : undefined,
    storageClass: spec.storageClassName,
  };
}

/**
 * The PersistentVolumes of a cluster, indexed both ways a logical
 * volume can be matched to one.
 *
 * @param persistentVolumes
 * @returns
 */
function indexPersistentVolumes(persistentVolumes: PersistentVolumeObject[]) {
  const byVolumeID = new Map<string, PersistentVolumeObject>();
  const byName = new Map<string, PersistentVolumeObject>();

  persistentVolumes.forEach(pv => {
    byName.set(pv.getName(), pv);

    const handle = (pv.spec as { csi?: { volumeHandle?: string } }).csi?.volumeHandle;
    if (handle) {
      byVolumeID.set(handle, pv);
    }
  });

  return { byVolumeID, byName };
}

/**
 * The PersistentVolume using a logical volume, if there is one.
 *
 * The volume ID is the authoritative match: TopoLVM writes the same
 * value into the PV's `spec.csi.volumeHandle` and the logical volume's
 * `status.volumeID`, and it survives either object being renamed.
 *
 * The name is a fallback for the window before a volume ID exists, when
 * a dynamically provisioned volume has already been named after the PV
 * it is being created for. It is a weaker claim, which is why the match
 * says which of the two it was.
 *
 * @param name
 * @param volumeID
 * @param index
 * @returns
 */
function matchPersistentVolume(
  name: string,
  volumeID: string | undefined,
  index: ReturnType<typeof indexPersistentVolumes>
): LogicalVolumeClaimant | undefined {
  const byVolumeID = volumeID ? index.byVolumeID.get(volumeID) : undefined;
  if (byVolumeID) {
    return describePersistentVolume(byVolumeID, 'volumeID');
  }

  const byName = index.byName.get(name);
  if (byName) {
    return describePersistentVolume(byName, 'name');
  }

  return undefined;
}

/**
 * The TopoLVM logical volumes, each matched to its PersistentVolume.
 *
 * @returns
 */
export function useLogicalVolumes(): LogicalVolumesResult {
  const [logicalVolumes, logicalVolumesError] = LogicalVolumeClass.useList();
  const [persistentVolumes] = K8s.ResourceClasses.PersistentVolume.useList();
  const [nodes] = K8s.ResourceClasses.Node.useList();

  const volumes = useMemo(() => {
    if (logicalVolumes === null) {
      return null;
    }

    const index = indexPersistentVolumes(persistentVolumes ?? []);

    // Null until the node list has arrived. Calling a node missing
    // before then would flag every volume in the cluster.
    const knownNodes = nodes === null ? null : new Set(nodes.map(node => node.getName()));

    return logicalVolumes.map(item => {
      const spec = (item.jsonData.spec ?? {}) as LogicalVolumeSpec;
      const status = (item.jsonData.status ?? {}) as LogicalVolumeStatus;
      const name = item.getName();

      return {
        logicalVolume: item,
        name,
        nodeName: spec.nodeName,
        nodeMissing: !!spec.nodeName && knownNodes !== null && !knownNodes.has(spec.nodeName),
        deviceClass: spec.deviceClass,
        requestedBytes: parseStorageQuantity(spec.size),
        currentBytes: parseStorageQuantity(status.currentSize),
        volumeID: status.volumeID,
        error:
          status.code || status.message
            ? { code: status.code, message: status.message }
            : undefined,
        creationTimestamp: item.metadata.creationTimestamp,
        persistentVolume: matchPersistentVolume(name, status.volumeID, index),
      } satisfies LogicalVolume;
    });
  }, [logicalVolumes, persistentVolumes, nodes]);

  return {
    volumes,
    error: isAbsent(logicalVolumesError) ? null : logicalVolumesError,
    crdMissing: isAbsent(logicalVolumesError),
  };
}

/**
 * The logical volumes on one node.
 *
 * @param volumes
 * @param nodeName
 * @returns
 */
export function filterLogicalVolumesForNode(
  volumes: LogicalVolume[],
  nodeName: string
): LogicalVolume[] {
  return volumes.filter(volume => volume.nodeName === nodeName);
}

export interface LogicalVolumeTotals {
  count: number;
  withPersistentVolume: number;
  withoutPersistentVolume: number;
  bytes: number;
  bytesWithoutPersistentVolume: number;
}

/**
 * What a set of logical volumes comes to.
 *
 * The size counted is the one on the node where it is known, falling
 * back to the size asked for, because the question being answered is
 * how much of a volume group is spoken for.
 *
 * @param volumes
 * @returns
 */
export function getLogicalVolumeTotals(volumes: LogicalVolume[]): LogicalVolumeTotals {
  return volumes.reduce<LogicalVolumeTotals>(
    (totals, volume) => {
      const bytes = volume.currentBytes ?? volume.requestedBytes ?? 0;

      totals.count += 1;
      totals.bytes += bytes;

      if (volume.persistentVolume) {
        totals.withPersistentVolume += 1;
      } else {
        totals.withoutPersistentVolume += 1;
        totals.bytesWithoutPersistentVolume += bytes;
      }

      return totals;
    },
    {
      count: 0,
      withPersistentVolume: 0,
      withoutPersistentVolume: 0,
      bytes: 0,
      bytesWithoutPersistentVolume: 0,
    }
  );
}
