import { K8s, Router } from '@kinvolk/headlamp-plugin/lib';
import {
  Link,
  Loader,
  NameValueTable,
  SectionBox,
  StatusLabel,
  Table,
} from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import Alert from '@mui/material/Alert';
import { useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { formatBytes, formatCount, NOT_AVAILABLE, usageFraction } from '../lib/format';
import { filterVolumesForNode, useLocalVolumes } from '../lib/localVolumes';
import {
  filterLogicalVolumesForNode,
  getDeviceClassFreeBytes,
  getLogicalVolumeTotals,
  useLogicalVolumes,
} from '../lib/logicalVolumes';
import {
  getDiskPressure,
  getNodeStorage,
  getPodEphemeralUsage,
  getVolumeStatsByClaim,
  PodEphemeralUsage,
  STATS_UNAVAILABLE_HINT,
  useNodeSummary,
} from '../lib/nodeStorage';
import { OVERVIEW_ROUTE_NAME } from '../routes';
import GaugeGrid from './GaugeGrid';
import LocalVolumesTable from './LocalVolumesTable';
import LogicalVolumesTable from './LogicalVolumesTable';
import StorageGauge from './StorageGauge';

/** Storage of a single node: its filesystems, its local PVs and its noisiest pods. */
export default function NodeStorageDetails() {
  const { nodeName } = useParams<{ nodeName: string }>();
  const [node, nodeError] = K8s.ResourceClasses.Node.useGet(nodeName);
  const [allNodes] = K8s.ResourceClasses.Node.useList();
  const { summary, error: statsError, loading } = useNodeSummary(nodeName);

  // The full node list is what tells apart a volume pinned to a live node from
  // one left behind by a node that has been removed.
  const nodeNames = useMemo(
    () => (allNodes ?? [node]).filter(Boolean).map(item => item!.getName()),
    [allNodes, node]
  );
  const [localVolumes, volumesError] = useLocalVolumes(nodeNames);
  const {
    volumes: logicalVolumes,
    error: logicalVolumesError,
    crdMissing: noTopolvm,
  } = useLogicalVolumes();

  const backLink = Router.createRouteURL(OVERVIEW_ROUTE_NAME);
  const volumesOnNode = useMemo(
    () => (localVolumes === null ? null : filterVolumesForNode(localVolumes, nodeName)),
    [localVolumes, nodeName]
  );
  const volumeStatsByClaim = useMemo(() => getVolumeStatsByClaim(summary), [summary]);
  const logicalVolumesOnNode = useMemo(
    () => (logicalVolumes === null ? null : filterLogicalVolumesForNode(logicalVolumes, nodeName)),
    [logicalVolumes, nodeName]
  );
  const logicalVolumeTotals = useMemo(
    () => getLogicalVolumeTotals(logicalVolumesOnNode ?? []),
    [logicalVolumesOnNode]
  );
  const podUsage = useMemo(() => getPodEphemeralUsage(summary), [summary]);

  if (nodeError) {
    return (
      <SectionBox title={nodeName} backLink={backLink}>
        <Alert severity="error">
          Could not read node {nodeName}: {nodeError.message}
        </Alert>
      </SectionBox>
    );
  }

  if (node === null) {
    return (
      <SectionBox title={nodeName} backLink={backLink}>
        <Loader title={`Loading node ${nodeName}`} />
      </SectionBox>
    );
  }

  const storage = getNodeStorage(node, summary, statsError);
  const nodeInfo = node.jsonData.status?.nodeInfo;
  const diskPressure = getDiskPressure(node);
  const deviceClassFree = getDeviceClassFreeBytes(node);

  return (
    <>
      <SectionBox title={nodeName} subtitle="Local storage" backLink={backLink}>
        {statsError && !loading && (
          <Alert severity="info" sx={{ mb: 2 }}>
            {STATS_UNAVAILABLE_HINT} ({statsError})
          </Alert>
        )}

        <GaugeGrid>
          <StorageGauge
            title="Root filesystem"
            usage={storage.rootFs}
            infoTooltip="The filesystem the kubelet stores pod data and ephemeral volumes on (nodefs)."
            unavailableMessage={
              storage.capacityBytes !== undefined
                ? `Capacity ${formatBytes(storage.capacityBytes)}, usage unavailable`
                : 'Usage unavailable'
            }
          />
          {storage.imageFs && !storage.imageFsShared && (
            <StorageGauge
              title="Image filesystem"
              usage={storage.imageFs}
              infoTooltip="The filesystem holding container images and writable layers (imagefs)."
            />
          )}
          {storage.rootFs?.inodes !== undefined && (
            <StorageGauge
              title="Inodes"
              usage={{
                capacityBytes: storage.rootFs.inodes,
                usedBytes: storage.rootFs.inodesUsed,
              }}
              formatValue={formatCount}
              infoTooltip="Inodes used on the root filesystem. A node can run out of these before it runs out of space."
            />
          )}
        </GaugeGrid>
      </SectionBox>

      <SectionBox title="Details">
        <NameValueTable
          rows={[
            {
              name: 'Node',
              value: (
                <Link routeName="node" params={{ name: nodeName }}>
                  {nodeName}
                </Link>
              ),
            },
            {
              name: 'Disk pressure',
              value: (
                <StatusLabel
                  status={
                    diskPressure === 'pressure' ? 'error' : diskPressure === 'ok' ? 'success' : ''
                  }
                >
                  {diskPressure === 'pressure'
                    ? 'Under pressure'
                    : diskPressure === 'ok'
                    ? 'OK'
                    : 'Unknown'}
                </StatusLabel>
              ),
            },
            {
              name: 'Root filesystem',
              value: `${formatBytes(storage.rootFs?.usedBytes)} used, ${formatBytes(
                storage.rootFs?.availableBytes
              )} available of ${formatBytes(storage.rootFs?.capacityBytes)}`,
              hide: !storage.rootFs,
            },
            {
              name: 'Image filesystem',
              value: storage.imageFsShared
                ? 'Shares the root filesystem'
                : `${formatBytes(storage.imageFs?.usedBytes)} used of ${formatBytes(
                    storage.imageFs?.capacityBytes
                  )}`,
              hide: !storage.imageFs,
            },
            {
              name: 'Inodes',
              value: `${formatCount(storage.rootFs?.inodesUsed)} used of ${formatCount(
                storage.rootFs?.inodes
              )}`,
              hide: storage.rootFs?.inodes === undefined,
            },
            {
              name: 'Ephemeral storage capacity',
              value: formatBytes(storage.capacityBytes),
              hide: storage.capacityBytes === undefined,
            },
            {
              name: 'Ephemeral storage allocatable',
              value: `${formatBytes(
                storage.allocatableBytes
              )} (the rest is reserved for the system)`,
              hide: storage.allocatableBytes === undefined,
            },
            {
              name: 'Local persistent volumes',
              value: volumesOnNode === null ? NOT_AVAILABLE : `${volumesOnNode.length}`,
            },
            {
              name: 'Logical volumes',
              value:
                logicalVolumesOnNode === null
                  ? NOT_AVAILABLE
                  : `${logicalVolumeTotals.count} using ${formatBytes(logicalVolumeTotals.bytes)}` +
                    (logicalVolumeTotals.withoutPersistentVolume > 0
                      ? `, ${logicalVolumeTotals.withoutPersistentVolume} without a persistent volume`
                      : ''),
              hide: noTopolvm,
            },
            ...Object.entries(deviceClassFree).map(([deviceClass, bytes]) => ({
              name: `Volume group free (${deviceClass})`,
              value: formatBytes(bytes),
            })),
            {
              name: 'Operating system',
              value: nodeInfo ? `${nodeInfo.osImage} (${nodeInfo.architecture})` : NOT_AVAILABLE,
              hide: !nodeInfo,
            },
            {
              name: 'Container runtime',
              value: nodeInfo?.containerRuntimeVersion,
              hide: !nodeInfo?.containerRuntimeVersion,
            },
          ]}
        />
      </SectionBox>

      <SectionBox
        title="Local Persistent Volumes"
        subtitle={`PersistentVolumes pinned to ${nodeName}.`}
      >
        <LocalVolumesTable
          volumes={volumesOnNode}
          volumeStatsByClaim={volumeStatsByClaim}
          hideNodeColumn
          errorMessage={volumesError ? volumesError.message : undefined}
          emptyMessage={`No node-local persistent volumes are pinned to ${nodeName}.`}
        />
      </SectionBox>

      {!noTopolvm && (
        <SectionBox
          title="Logical Volumes"
          subtitle={`TopoLVM logical volumes in ${nodeName}'s volume group.`}
        >
          <LogicalVolumesTable
            volumes={logicalVolumesOnNode}
            hideNodeColumn
            errorMessage={
              logicalVolumesError
                ? String(
                    (logicalVolumesError as { message?: string }).message ?? logicalVolumesError
                  )
                : undefined
            }
            emptyMessage={`No logical volumes live on ${nodeName}.`}
          />
        </SectionBox>
      )}

      <SectionBox
        title="Pod Ephemeral Storage"
        subtitle="How much of this node's disk each pod is using for ephemeral storage."
      >
        <Table
          loading={loading && podUsage.length === 0}
          errorMessage={statsError}
          emptyMessage="The kubelet did not report ephemeral storage for any pod on this node."
          data={podUsage}
          columns={[
            {
              id: 'name',
              header: 'Pod',
              gridTemplate: 2,
              accessorFn: (pod: PodEphemeralUsage) => pod.name,
              Cell: ({ row }) => (
                <Link
                  routeName="pod"
                  params={{ namespace: row.original.namespace, name: row.original.name }}
                >
                  {row.original.name}
                </Link>
              ),
            },
            {
              id: 'namespace',
              header: 'Namespace',
              gridTemplate: 1.2,
              accessorFn: (pod: PodEphemeralUsage) => pod.namespace,
              Cell: ({ row }) => (
                <Link routeName="namespace" params={{ name: row.original.namespace }}>
                  {row.original.namespace}
                </Link>
              ),
            },
            {
              id: 'used',
              header: 'Used',
              gridTemplate: 0.8,
              accessorFn: (pod: PodEphemeralUsage) => pod.usedBytes ?? 0,
              Cell: ({ row }) => formatBytes(row.original.usedBytes),
            },
            {
              id: 'share',
              header: 'Share of node',
              gridTemplate: 1,
              accessorFn: (pod: PodEphemeralUsage) =>
                usageFraction(pod.usedBytes, storage.rootFs?.capacityBytes) ?? -1,
              Cell: ({ row }) => {
                const fraction = usageFraction(
                  row.original.usedBytes,
                  storage.rootFs?.capacityBytes
                );
                return fraction === null ? NOT_AVAILABLE : `${(fraction * 100).toFixed(2)}%`;
              },
            },
            {
              id: 'inodes',
              header: 'Inodes',
              gridTemplate: 0.7,
              accessorFn: (pod: PodEphemeralUsage) => pod.inodesUsed ?? 0,
              Cell: ({ row }) => formatCount(row.original.inodesUsed),
            },
          ]}
        />
      </SectionBox>
    </>
  );
}
