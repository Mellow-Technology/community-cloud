/**
 * @file
 * Which PersistentVolumes are tied to one machine's disks.
 *
 * A PV on a network filesystem can be used from anywhere; a PV on a
 * node's own disk can only be used from that node, and if that node
 * goes away the data goes with it. Nothing in the PV marks the
 * difference, so it has to be worked out from the volume source.
 *
 * `local` and `hostPath` say so outright. Everything else says it with
 * a `nodeAffinity`, which is how the local storage CSI drivers express
 * placement — and each of them picks its own topology key to do it
 * with: `topology.topolvm.io/node` for TopoLVM, `openebs.io/nodename`
 * for OpenEBS, `kubernetes.io/hostname` for the in-tree provisioners.
 *
 * Matching keys driver by driver means a cluster running something not
 * on the list shows nothing, with no hint that anything is missing. So
 * the values are checked against the cluster's actual node names
 * instead, whatever key they came under, and the keys are only
 * consulted for the volumes left over — the ones naming a node that is
 * no longer there. Those matter most of all: a volume pinned to a node
 * that has been removed is storage nobody can reach and nobody is
 * watching.
 */
import { K8s } from '@kinvolk/headlamp-plugin/lib';
import { useMemo } from 'react';
import { buildNodeKey, readNodeKey } from './nodeNames';
import { parseStorageQuantity } from './nodeStorage';

export type PersistentVolumeObject = InstanceType<typeof K8s.ResourceClasses.PersistentVolume>;

/** What makes a volume local: its source, or failing that its affinity. */
export type LocalVolumeKind = 'local' | 'hostPath' | 'csi' | 'nodeAffinity';

export interface LocalVolume {
  pv: PersistentVolumeObject;
  name: string;
  kind: LocalVolumeKind;
  /** The volume source in words, e.g. `Local` or `CSI (topolvm.io)`. */
  typeLabel: string;
  /** The path on the node, for the sources that have one. */
  path?: string;
  /** The nodes this volume is pinned to. Empty when it is pinned to none. */
  nodes: string[];
  /** The subset of `nodes` that is no longer part of the cluster. */
  missingNodes: string[];
  capacityBytes?: number;
  claim?: { name: string; namespace: string };
  storageClass?: string;
  phase: string;
}

interface NodeSelectorRequirement {
  key: string;
  operator: string;
  values?: string[];
}

interface PersistentVolumeSpec {
  capacity?: { storage?: string };
  claimRef?: { name?: string; namespace?: string };
  storageClassName?: string;
  local?: { path?: string };
  hostPath?: { path?: string };
  csi?: { driver?: string; volumeHandle?: string; volumeAttributes?: Record<string, string> };
  nodeAffinity?: {
    required?: {
      nodeSelectorTerms?: {
        matchExpressions?: NodeSelectorRequirement[];
        matchFields?: NodeSelectorRequirement[];
      }[];
    };
  };
  [other: string]: any;
}

/**
 * Topology keys whose values are node names.
 *
 * Only consulted for a value that is not a node of this cluster, so
 * the cost of a key not on this list is a volume for a departed node
 * going unnoticed, not a volume being missed altogether.
 *
 * The shape of these is consistent even though the prefixes are not:
 * `kubernetes.io/hostname`, `topology.topolvm.io/node`,
 * `openebs.io/nodename`.
 */
const NODE_TOPOLOGY_KEY = /(^|\/)(hostname|node|nodename)$/i;

/**
 * Whether a requirement's values are node names.
 *
 * @param key
 * @returns
 */
function isNodeTopologyKey(key: string): boolean {
  return key === 'metadata.name' || NODE_TOPOLOGY_KEY.test(key);
}

/**
 * The nodes a PV is pinned to.
 *
 * A value counts as a node name when it matches a node of the cluster,
 * or when the key it came under is one that holds node names. Only
 * `In` is read: an affinity written with `NotIn` is saying where the
 * volume may not go, which is not a pinning.
 *
 * @param pv
 * @param knownNodeNames
 * @returns
 */
export function getPersistentVolumeNodes(
  pv: PersistentVolumeObject,
  knownNodeNames: string[]
): string[] {
  const spec = pv.spec as PersistentVolumeSpec;
  const terms = spec.nodeAffinity?.required?.nodeSelectorTerms ?? [];
  const knownNodes = new Set(knownNodeNames);
  const nodes = new Set<string>();

  terms.forEach(term => {
    [...(term.matchExpressions ?? []), ...(term.matchFields ?? [])].forEach(requirement => {
      if (requirement.operator !== 'In') {
        return;
      }

      const keyNamesANode = isNodeTopologyKey(requirement.key);
      (requirement.values ?? []).forEach(value => {
        if (keyNamesANode || knownNodes.has(value)) {
          nodes.add(value);
        }
      });
    });
  });

  return Array.from(nodes).sort();
}

/**
 * How a volume's source should be described, and what makes it local.
 *
 * Null for a volume that is not local at all. A `csi` source with no
 * pinning is one of those: a CSI driver is not inherently local, and
 * without an affinity there is nothing saying this one is.
 *
 * @param spec
 * @param nodes
 * @returns
 */
function describeSource(
  spec: PersistentVolumeSpec,
  nodes: string[]
): { kind: LocalVolumeKind; typeLabel: string; path?: string } | null {
  if (spec.local) {
    return { kind: 'local', typeLabel: 'Local', path: spec.local.path };
  }
  if (spec.hostPath) {
    return { kind: 'hostPath', typeLabel: 'HostPath', path: spec.hostPath.path };
  }
  if (spec.csi && nodes.length > 0) {
    return { kind: 'csi', typeLabel: `CSI (${spec.csi.driver ?? 'unknown driver'})` };
  }
  if (nodes.length > 0) {
    return { kind: 'nodeAffinity', typeLabel: 'Node affinity' };
  }

  return null;
}

/**
 * A PV as a local volume, or null when it is not one.
 *
 * @param pv
 * @param knownNodeNames
 * @returns
 */
export function toLocalVolume(
  pv: PersistentVolumeObject,
  knownNodeNames: string[]
): LocalVolume | null {
  const spec = pv.spec as PersistentVolumeSpec;
  const nodes = getPersistentVolumeNodes(pv, knownNodeNames);
  const source = describeSource(spec, nodes);

  if (source === null) {
    return null;
  }

  const claimRef = spec.claimRef;
  const knownNodes = new Set(knownNodeNames);

  return {
    pv,
    name: pv.getName(),
    kind: source.kind,
    typeLabel: source.typeLabel,
    path: source.path,
    nodes,
    missingNodes: nodes.filter(node => !knownNodes.has(node)),
    capacityBytes: parseStorageQuantity(spec.capacity?.storage),
    claim:
      claimRef?.name && claimRef?.namespace
        ? { name: claimRef.name, namespace: claimRef.namespace }
        : undefined,
    storageClass: spec.storageClassName,
    phase: pv.status?.phase ?? 'Unknown',
  };
}

/**
 * The node-local PersistentVolumes in the cluster.
 *
 * @param knownNodeNames
 * @returns
 */
export function useLocalVolumes(knownNodeNames: string[]) {
  const [persistentVolumes, error] = K8s.ResourceClasses.PersistentVolume.useList();
  const nodeKey = buildNodeKey(knownNodeNames);

  const localVolumes = useMemo(() => {
    if (persistentVolumes === null) {
      return null;
    }

    const names = readNodeKey(nodeKey);

    return persistentVolumes
      .map(pv => toLocalVolume(pv, names))
      .filter((volume): volume is LocalVolume => volume !== null);
  }, [persistentVolumes, nodeKey]);

  return [localVolumes, error] as const;
}

/**
 * The local volumes pinned to one node.
 *
 * @param volumes
 * @param nodeName
 * @returns
 */
export function filterVolumesForNode(volumes: LocalVolume[], nodeName: string): LocalVolume[] {
  return volumes.filter(volume => volume.nodes.includes(nodeName));
}
