import {
  HoverInfoLabel,
  Link,
  StatusLabel,
  Table,
} from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { formatBytes, NOT_AVAILABLE, usageFraction } from '../lib/format';
import { LocalVolume } from '../lib/localVolumes';
import { KubeletVolumeStats } from '../lib/nodeStorage';
import UsageBar from './UsageBar';

export interface LocalVolumesTableProps {
  volumes: LocalVolume[] | null;
  /** Per-claim usage from the kubelet, keyed by `namespace/name` of the PVC. */
  volumeStatsByClaim?: Record<string, KubeletVolumeStats>;
  /** Hide the node column, e.g. on a single node's page. */
  hideNodeColumn?: boolean;
  errorMessage?: string;
  emptyMessage?: string;
}

function statusFor(phase: string): 'success' | 'warning' | 'error' | '' {
  switch (phase) {
    case 'Bound':
    case 'Available':
      return 'success';
    case 'Released':
    case 'Pending':
      return 'warning';
    case 'Failed':
      return 'error';
    default:
      return '';
  }
}

/** Lists node-local PersistentVolumes, with live usage where the kubelet reports it. */
export default function LocalVolumesTable(props: LocalVolumesTableProps) {
  const {
    volumes,
    volumeStatsByClaim = {},
    hideNodeColumn = false,
    errorMessage,
    emptyMessage = 'No node-local persistent volumes were found.',
  } = props;

  function statsFor(volume: LocalVolume): KubeletVolumeStats | undefined {
    if (!volume.claim) {
      return undefined;
    }
    return volumeStatsByClaim[`${volume.claim.namespace}/${volume.claim.name}`];
  }

  return (
    <Table
      loading={volumes === null && !errorMessage}
      errorMessage={errorMessage}
      emptyMessage={emptyMessage}
      data={volumes ?? []}
      columns={[
        {
          id: 'name',
          header: 'Name',
          gridTemplate: 1.6,
          accessorFn: (volume: LocalVolume) => volume.name,
          Cell: ({ row }) => <Link kubeObject={row.original.pv}>{row.original.name}</Link>,
        },
        ...(hideNodeColumn
          ? []
          : [
              {
                id: 'nodes',
                header: 'Node',
                gridTemplate: 1.3,
                accessorFn: (volume: LocalVolume) =>
                  volume.nodes.length > 0 ? volume.nodes.join(', ') : 'Any node',
                Cell: ({ row }: { row: { original: LocalVolume } }) =>
                  row.original.nodes.length === 0 ? (
                    <Typography variant="body2">Any node</Typography>
                  ) : (
                    <Box display="flex" flexWrap="wrap" gap={0.5}>
                      {row.original.nodes.map(nodeName =>
                        row.original.missingNodes.includes(nodeName) ? (
                          <HoverInfoLabel
                            key={nodeName}
                            label={nodeName}
                            hoverInfo="This node is not part of the cluster any more."
                            icon="mdi:alert-outline"
                          />
                        ) : (
                          <Link key={nodeName} routeName="node" params={{ name: nodeName }}>
                            {nodeName}
                          </Link>
                        )
                      )}
                    </Box>
                  ),
              },
            ]),
        {
          id: 'type',
          header: 'Type',
          gridTemplate: 1.2,
          accessorFn: (volume: LocalVolume) => volume.typeLabel,
        },
        {
          id: 'path',
          header: 'Path',
          gridTemplate: 1.5,
          accessorFn: (volume: LocalVolume) => volume.path ?? NOT_AVAILABLE,
        },
        {
          id: 'capacity',
          header: 'Capacity',
          gridTemplate: 0.8,
          accessorFn: (volume: LocalVolume) => volume.capacityBytes ?? 0,
          Cell: ({ row }) => formatBytes(row.original.capacityBytes),
        },
        {
          id: 'used',
          header: 'Used',
          gridTemplate: 0.8,
          accessorFn: (volume: LocalVolume) => statsFor(volume)?.usedBytes ?? 0,
          Cell: ({ row }) => formatBytes(statsFor(row.original)?.usedBytes),
        },
        {
          id: 'usage',
          header: 'Usage',
          gridTemplate: 1.1,
          accessorFn: (volume: LocalVolume) => {
            const stats = statsFor(volume);
            return (
              usageFraction(stats?.usedBytes, stats?.capacityBytes ?? volume.capacityBytes) ?? -1
            );
          },
          Cell: ({ row }) => {
            const stats = statsFor(row.original);
            return (
              <UsageBar
                fraction={usageFraction(
                  stats?.usedBytes,
                  stats?.capacityBytes ?? row.original.capacityBytes
                )}
              />
            );
          },
        },
        {
          id: 'claim',
          header: 'Claim',
          gridTemplate: 1.4,
          accessorFn: (volume: LocalVolume) =>
            volume.claim ? `${volume.claim.namespace}/${volume.claim.name}` : NOT_AVAILABLE,
          Cell: ({ row }) => {
            const claim = row.original.claim;
            if (!claim) {
              return NOT_AVAILABLE;
            }
            return (
              <Link
                routeName="persistentVolumeClaim"
                params={{ namespace: claim.namespace, name: claim.name }}
                tooltip={`${claim.namespace}/${claim.name}`}
              >
                {claim.name}
              </Link>
            );
          },
        },
        {
          id: 'storageClass',
          header: 'Storage class',
          gridTemplate: 1.1,
          accessorFn: (volume: LocalVolume) => volume.storageClass ?? NOT_AVAILABLE,
        },
        {
          id: 'status',
          header: 'Status',
          gridTemplate: 0.8,
          accessorFn: (volume: LocalVolume) => volume.phase,
          Cell: ({ row }) => (
            <StatusLabel status={statusFor(row.original.phase)}>{row.original.phase}</StatusLabel>
          ),
        },
      ]}
    />
  );
}
