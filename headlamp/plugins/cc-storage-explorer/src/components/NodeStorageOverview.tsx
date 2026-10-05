import { K8s } from '@kinvolk/headlamp-plugin/lib';
import {
  Link,
  SectionBox,
  StatusLabel,
  Table,
} from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import { useMemo } from 'react';
import { formatBytes, NOT_AVAILABLE, usageFraction } from '../lib/format';
import { LocalVolume, useLocalVolumes } from '../lib/localVolumes';
import { LogicalVolume, useLogicalVolumes } from '../lib/logicalVolumes';
import {
  getDiskPressure,
  getNodeStorage,
  NodeObject,
  NodeStorage,
  STATS_UNAVAILABLE_HINT,
  useNodeSummaries,
} from '../lib/nodeStorage';
import { DETAILS_ROUTE_NAME } from '../routes';
import GaugeGrid from './GaugeGrid';
import LocalVolumesTable from './LocalVolumesTable';
import StorageGauge from './StorageGauge';
import UsageBar from './UsageBar';

interface NodeRow {
  node: NodeObject;
  storage: NodeStorage;
  localVolumeCount: number;
  logicalVolumeCount: number;
  diskPressure: ReturnType<typeof getDiskPressure>;
}

const diskPressureLabels: Record<
  NodeRow['diskPressure'],
  { text: string; status: 'success' | 'error' | '' }
> = {
  ok: { text: 'OK', status: 'success' },
  pressure: { text: 'Disk pressure', status: 'error' },
  unknown: { text: 'Unknown', status: '' },
};

/**
 * Overview of the local disks of every node in the cluster, plus the
 * node-local PersistentVolumes bound to them.
 */
export default function NodeStorageOverview() {
  const [nodes, nodesError] = K8s.ResourceClasses.Node.useList();

  const nodeNames = useMemo(() => (nodes ?? []).map(node => node.getName()).sort(), [nodes]);
  const { summaries, errors, loading } = useNodeSummaries(nodeNames);
  const [localVolumes, volumesError] = useLocalVolumes(nodeNames);
  const { volumes: logicalVolumes, crdMissing: noTopolvm } = useLogicalVolumes();

  const rows: NodeRow[] = useMemo(
    () =>
      (nodes ?? []).map(node => {
        const name = node.getName();
        return {
          node,
          storage: getNodeStorage(node, summaries[name], errors[name]),
          localVolumeCount: (localVolumes ?? []).filter((volume: LocalVolume) =>
            volume.nodes.includes(name)
          ).length,
          logicalVolumeCount: (logicalVolumes ?? []).filter(
            (volume: LogicalVolume) => volume.nodeName === name
          ).length,
          diskPressure: getDiskPressure(node),
        };
      }),
    [nodes, summaries, errors, localVolumes, logicalVolumes]
  );

  const clusterTotals = useMemo(() => {
    let capacityBytes = 0;
    let usedBytes = 0;
    let counted = 0;

    rows.forEach(({ storage }) => {
      if (storage.rootFs?.capacityBytes !== undefined) {
        capacityBytes += storage.rootFs.capacityBytes;
        usedBytes += storage.rootFs.usedBytes ?? 0;
        counted += 1;
      }
    });

    return counted > 0 ? { capacityBytes, usedBytes, counted } : undefined;
  }, [rows]);

  const everyNodeFailed = nodeNames.length > 0 && Object.keys(errors).length === nodeNames.length;

  return (
    <>
      <SectionBox title="Node Storage" subtitle="Local disk usage reported by each node's kubelet.">
        {everyNodeFailed && !loading && (
          <Alert severity="info" sx={{ mb: 2 }}>
            {STATS_UNAVAILABLE_HINT} Capacity below comes from the Node objects instead.
          </Alert>
        )}
        {nodesError && <Alert severity="error">Could not list nodes: {nodesError.message}</Alert>}

        <GaugeGrid>
          {clusterTotals && (
            <StorageGauge
              title="All nodes"
              usage={{
                capacityBytes: clusterTotals.capacityBytes,
                usedBytes: clusterTotals.usedBytes,
              }}
              legendSuffix={`across ${clusterTotals.counted} node${
                clusterTotals.counted === 1 ? '' : 's'
              }`}
              infoTooltip="Sum of the root filesystems of every node reporting usage."
            />
          )}
          {rows.map(({ storage }) => (
            <StorageGauge
              key={storage.nodeName}
              title={
                <Link routeName={DETAILS_ROUTE_NAME} params={{ nodeName: storage.nodeName }}>
                  {storage.nodeName}
                </Link>
              }
              usage={storage.rootFs}
              unavailableMessage={
                storage.capacityBytes !== undefined
                  ? `Capacity ${formatBytes(storage.capacityBytes)}, usage unavailable`
                  : 'Usage unavailable'
              }
              infoTooltip={
                storage.statsError ? `${STATS_UNAVAILABLE_HINT} (${storage.statsError})` : null
              }
            />
          ))}
        </GaugeGrid>
      </SectionBox>

      <SectionBox title="Nodes">
        <Table
          loading={nodes === null}
          errorMessage={nodesError ? nodesError.message : undefined}
          emptyMessage="No nodes found."
          data={rows}
          columns={[
            {
              id: 'name',
              header: 'Name',
              gridTemplate: 1.7,
              accessorFn: (row: NodeRow) => row.storage.nodeName,
              Cell: ({ row }) => (
                <Link
                  routeName={DETAILS_ROUTE_NAME}
                  params={{ nodeName: row.original.storage.nodeName }}
                >
                  {row.original.storage.nodeName}
                </Link>
              ),
            },
            {
              id: 'capacity',
              header: 'Capacity',
              gridTemplate: 0.9,
              accessorFn: (row: NodeRow) =>
                row.storage.rootFs?.capacityBytes ?? row.storage.capacityBytes ?? 0,
              Cell: ({ row }) =>
                formatBytes(
                  row.original.storage.rootFs?.capacityBytes ?? row.original.storage.capacityBytes
                ),
            },
            {
              id: 'used',
              header: 'Used',
              gridTemplate: 0.9,
              accessorFn: (row: NodeRow) => row.storage.rootFs?.usedBytes ?? 0,
              Cell: ({ row }) => formatBytes(row.original.storage.rootFs?.usedBytes),
            },
            {
              id: 'available',
              header: 'Available',
              gridTemplate: 0.9,
              accessorFn: (row: NodeRow) => row.storage.rootFs?.availableBytes ?? 0,
              Cell: ({ row }) => formatBytes(row.original.storage.rootFs?.availableBytes),
            },
            {
              id: 'usage',
              header: 'Usage',
              gridTemplate: 1.3,
              accessorFn: (row: NodeRow) =>
                usageFraction(row.storage.rootFs?.usedBytes, row.storage.rootFs?.capacityBytes) ??
                -1,
              Cell: ({ row }) => (
                <UsageBar
                  fraction={usageFraction(
                    row.original.storage.rootFs?.usedBytes,
                    row.original.storage.rootFs?.capacityBytes
                  )}
                />
              ),
            },
            {
              id: 'inodes',
              header: 'Inodes used',
              gridTemplate: 1.1,
              accessorFn: (row: NodeRow) =>
                usageFraction(row.storage.rootFs?.inodesUsed, row.storage.rootFs?.inodes) ?? -1,
              Cell: ({ row }) => (
                <UsageBar
                  fraction={usageFraction(
                    row.original.storage.rootFs?.inodesUsed,
                    row.original.storage.rootFs?.inodes
                  )}
                />
              ),
            },
            {
              id: 'allocatable',
              header: 'Ephemeral allocatable',
              gridTemplate: 1.1,
              accessorFn: (row: NodeRow) => row.storage.allocatableBytes ?? 0,
              Cell: ({ row }) =>
                row.original.storage.allocatableBytes === undefined
                  ? NOT_AVAILABLE
                  : formatBytes(row.original.storage.allocatableBytes),
            },
            {
              id: 'localVolumes',
              header: 'Local PVs',
              gridTemplate: 0.7,
              accessorFn: (row: NodeRow) => row.localVolumeCount,
            },
            ...(noTopolvm
              ? []
              : [
                  {
                    id: 'logicalVolumes',
                    header: 'Logical volumes',
                    gridTemplate: 1,
                    accessorFn: (row: NodeRow) => row.logicalVolumeCount,
                  },
                ]),
            {
              id: 'diskPressure',
              header: 'Disk pressure',
              gridTemplate: 1,
              accessorFn: (row: NodeRow) => diskPressureLabels[row.diskPressure].text,
              Cell: ({ row }) => {
                const label = diskPressureLabels[row.original.diskPressure];
                return <StatusLabel status={label.status}>{label.text}</StatusLabel>;
              },
            },
          ]}
        />
      </SectionBox>

      <SectionBox
        title="Local Persistent Volumes"
        subtitle="PersistentVolumes backed by a node's local disk."
      >
        <Box>
          <LocalVolumesTable
            volumes={localVolumes}
            errorMessage={volumesError ? volumesError.message : undefined}
          />
        </Box>
      </SectionBox>
    </>
  );
}
