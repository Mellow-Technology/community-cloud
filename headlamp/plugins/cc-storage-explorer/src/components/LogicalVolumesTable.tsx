import {
  DateLabel,
  HoverInfoLabel,
  Link,
  StatusLabel,
  Table,
} from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import { formatBytes, NOT_AVAILABLE } from '../lib/format';
import { LOGICAL_VOLUME_CRD, LogicalVolume } from '../lib/logicalVolumes';

export interface LogicalVolumesTableProps {
  volumes: LogicalVolume[] | null;
  /** Hide the node column, e.g. on a single node's page. */
  hideNodeColumn?: boolean;
  errorMessage?: string;
  emptyMessage?: string;
}

/** Size of a logical volume on the node, falling back to the requested size. */
function sizeBytes(volume: LogicalVolume): number | undefined {
  return volume.currentBytes ?? volume.requestedBytes;
}

function volumeState(volume: LogicalVolume): {
  text: string;
  status: 'success' | 'warning' | 'error' | '';
  detail?: string;
} {
  if (volume.error) {
    return {
      text: volume.error.code ? `Error ${volume.error.code}` : 'Error',
      status: 'error',
      detail: volume.error.message,
    };
  }
  if (!volume.volumeID) {
    return {
      text: 'Pending',
      status: 'warning',
      detail: 'TopoLVM has not reported a volume on the node yet.',
    };
  }
  return { text: 'Ready', status: 'success' };
}

/**
 * Lists TopoLVM logical volumes: where each one lives and whether a
 * PersistentVolume still refers to it.
 */
export default function LogicalVolumesTable(props: LogicalVolumesTableProps) {
  const {
    volumes,
    hideNodeColumn = false,
    errorMessage,
    emptyMessage = 'No TopoLVM logical volumes were found.',
  } = props;

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
          gridTemplate: 2.2,
          accessorFn: (volume: LogicalVolume) => volume.name,
          Cell: ({ row }) => (
            <Link
              routeName="customresource"
              params={{
                crd: LOGICAL_VOLUME_CRD,
                crName: row.original.name,
                namespace: '-',
              }}
              tooltip={row.original.name}
            >
              {row.original.name}
            </Link>
          ),
        },
        ...(hideNodeColumn
          ? []
          : [
              {
                id: 'node',
                header: 'Node',
                gridTemplate: 1.2,
                accessorFn: (volume: LogicalVolume) => volume.nodeName ?? NOT_AVAILABLE,
                Cell: ({ row }: { row: { original: LogicalVolume } }) => {
                  const { nodeName, nodeMissing } = row.original;
                  if (!nodeName) {
                    return NOT_AVAILABLE;
                  }
                  return nodeMissing ? (
                    <HoverInfoLabel
                      label={nodeName}
                      hoverInfo="This node is not part of the cluster any more."
                      icon="mdi:alert-outline"
                    />
                  ) : (
                    <Link routeName="node" params={{ name: nodeName }}>
                      {nodeName}
                    </Link>
                  );
                },
              },
            ]),
        {
          id: 'deviceClass',
          header: 'Device class',
          gridTemplate: 0.9,
          accessorFn: (volume: LogicalVolume) => volume.deviceClass ?? NOT_AVAILABLE,
        },
        {
          id: 'size',
          header: 'Size',
          gridTemplate: 0.8,
          accessorFn: (volume: LogicalVolume) => sizeBytes(volume) ?? 0,
          Cell: ({ row }) => formatBytes(sizeBytes(row.original)),
        },
        {
          id: 'requested',
          header: 'Requested',
          gridTemplate: 0.9,
          accessorFn: (volume: LogicalVolume) => volume.requestedBytes ?? 0,
          Cell: ({ row }) => {
            const { requestedBytes, currentBytes } = row.original;
            if (requestedBytes === undefined) {
              return NOT_AVAILABLE;
            }
            // Worth pointing out when the volume on disk is not the size asked for.
            return currentBytes !== undefined && currentBytes !== requestedBytes ? (
              <HoverInfoLabel
                label={formatBytes(requestedBytes)}
                hoverInfo={`The volume on the node is ${formatBytes(currentBytes)}.`}
                icon="mdi:alert-outline"
              />
            ) : (
              formatBytes(requestedBytes)
            );
          },
        },
        {
          id: 'persistentVolume',
          header: 'Persistent volume',
          gridTemplate: 2,
          accessorFn: (volume: LogicalVolume) => volume.persistentVolume?.name ?? 'None',
          Cell: ({ row }) => {
            const pv = row.original.persistentVolume;
            if (!pv) {
              return (
                <HoverInfoLabel
                  label="None"
                  hoverInfo="No PersistentVolume refers to this logical volume. It still uses space in the node's volume group."
                  icon="mdi:alert-outline"
                />
              );
            }
            return (
              <Link
                routeName="persistentVolume"
                params={{ name: pv.name }}
                tooltip={
                  pv.matchedBy === 'name'
                    ? `Matched by name; this volume has no volume ID yet.`
                    : pv.name
                }
              >
                {pv.name}
              </Link>
            );
          },
        },
        {
          id: 'claim',
          header: 'Claim',
          gridTemplate: 1.4,
          accessorFn: (volume: LogicalVolume) => {
            const claim = volume.persistentVolume?.claim;
            return claim ? `${claim.namespace}/${claim.name}` : NOT_AVAILABLE;
          },
          Cell: ({ row }) => {
            const claim = row.original.persistentVolume?.claim;
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
          id: 'state',
          header: 'State',
          gridTemplate: 0.9,
          accessorFn: (volume: LogicalVolume) => volumeState(volume).text,
          Cell: ({ row }) => {
            const state = volumeState(row.original);
            return state.detail ? (
              <HoverInfoLabel label={state.text} hoverInfo={state.detail} />
            ) : (
              <StatusLabel status={state.status}>{state.text}</StatusLabel>
            );
          },
        },
        {
          id: 'age',
          header: 'Age',
          gridTemplate: 0.7,
          accessorFn: (volume: LogicalVolume) => volume.creationTimestamp ?? '',
          Cell: ({ row }) =>
            row.original.creationTimestamp ? (
              <DateLabel date={row.original.creationTimestamp} />
            ) : (
              NOT_AVAILABLE
            ),
        },
      ]}
    />
  );
}
