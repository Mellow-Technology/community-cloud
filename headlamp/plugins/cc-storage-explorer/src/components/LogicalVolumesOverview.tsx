import { K8s } from '@kinvolk/headlamp-plugin/lib';
import {
  HoverInfoLabel,
  Link,
  SectionBox,
  Table,
} from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import { useMemo } from 'react';
import { formatBytes, formatCount, NOT_AVAILABLE } from '../lib/format';
import {
  getDeviceClassFreeBytes,
  getLogicalVolumeTotals,
  LogicalVolume,
  useLogicalVolumes,
} from '../lib/logicalVolumes';
import { DETAILS_ROUTE_NAME } from '../routes';
import GaugeGrid from './GaugeGrid';
import LogicalVolumesTable from './LogicalVolumesTable';
import StorageGauge from './StorageGauge';

const UNCLAIMED_TOOLTIP =
  'Logical volumes that no PersistentVolume refers to. They still occupy space ' +
  "in their node's volume group.";

export const CRD_MISSING_MESSAGE =
  'This cluster has no TopoLVM LogicalVolume resource (topolvm.io/v1), or you are ' +
  'not allowed to list it. Logical volumes are only shown on clusters using TopoLVM.';

interface NodeRow {
  nodeName: string;
  exists: boolean;
  count: number;
  bytes: number;
  withoutPersistentVolume: number;
  /** Free capacity per TopoLVM device class, from the node's annotations. */
  freeByDeviceClass: Record<string, number>;
}

/** All TopoLVM logical volumes in the cluster, grouped by the node they live on. */
export default function LogicalVolumesOverview() {
  const { volumes, error, crdMissing } = useLogicalVolumes();
  const [nodes] = K8s.ResourceClasses.Node.useList();

  const totals = useMemo(() => getLogicalVolumeTotals(volumes ?? []), [volumes]);

  const nodeRows: NodeRow[] = useMemo(() => {
    const rows = new Map<string, NodeRow>();

    function rowFor(nodeName: string, exists: boolean): NodeRow {
      if (!rows.has(nodeName)) {
        rows.set(nodeName, {
          nodeName,
          exists,
          count: 0,
          bytes: 0,
          withoutPersistentVolume: 0,
          freeByDeviceClass: {},
        });
      }
      return rows.get(nodeName)!;
    }

    (nodes ?? []).forEach(node => {
      const row = rowFor(node.getName(), true);
      row.freeByDeviceClass = getDeviceClassFreeBytes(node);
    });

    (volumes ?? []).forEach((volume: LogicalVolume) => {
      if (!volume.nodeName) {
        return;
      }
      const row = rowFor(volume.nodeName, !volume.nodeMissing);
      row.count += 1;
      row.bytes += volume.currentBytes ?? volume.requestedBytes ?? 0;
      if (!volume.persistentVolume) {
        row.withoutPersistentVolume += 1;
      }
    });

    return Array.from(rows.values()).sort((a, b) => a.nodeName.localeCompare(b.nodeName));
  }, [volumes, nodes]);

  const errorMessage = error ? String((error as { message?: string }).message ?? error) : undefined;

  return (
    <>
      <SectionBox
        title="Logical Volumes"
        subtitle="TopoLVM logical volumes, the node each one lives on, and the PersistentVolume using it."
      >
        {crdMissing && <Alert severity="info">{CRD_MISSING_MESSAGE}</Alert>}

        {!crdMissing && (
          <>
            {/*
              Both gauges measure what is unclaimed rather than what is
              in use, which is the way round that keeps the colour
              honest: these follow the same severity scale as every
              other gauge here, where a fuller ring is a worse state. A
              ring that filled up as more volumes found a home would
              turn amber for a cluster with nothing wrong with it.
            */}
            <Box mb={2}>
              <GaugeGrid>
                <StorageGauge
                  title="Unclaimed volumes"
                  usage={{
                    capacityBytes: totals.count,
                    usedBytes: totals.withoutPersistentVolume,
                  }}
                  formatValue={formatCount}
                  legend={`${totals.withoutPersistentVolume} of ${totals.count} logical volumes`}
                  unavailableMessage="No logical volumes"
                  infoTooltip={UNCLAIMED_TOOLTIP}
                />
                <StorageGauge
                  title="Unclaimed space"
                  usage={{
                    capacityBytes: totals.bytes,
                    usedBytes: totals.bytesWithoutPersistentVolume,
                  }}
                  legend={`${formatBytes(totals.bytesWithoutPersistentVolume)} of ${formatBytes(
                    totals.bytes
                  )}`}
                  unavailableMessage="No logical volumes"
                  infoTooltip={UNCLAIMED_TOOLTIP}
                />
              </GaugeGrid>
            </Box>

            <LogicalVolumesTable volumes={volumes} errorMessage={errorMessage} />
          </>
        )}
      </SectionBox>

      {!crdMissing && (
        <SectionBox title="Per Node" subtitle="Where the logical volumes live.">
          <Table
            loading={volumes === null && !errorMessage}
            emptyMessage="No nodes are hosting logical volumes."
            data={nodeRows}
            columns={[
              {
                id: 'node',
                header: 'Node',
                gridTemplate: 1.5,
                accessorFn: (row: NodeRow) => row.nodeName,
                Cell: ({ row }) =>
                  row.original.exists ? (
                    <Link
                      routeName={DETAILS_ROUTE_NAME}
                      params={{ nodeName: row.original.nodeName }}
                    >
                      {row.original.nodeName}
                    </Link>
                  ) : (
                    <HoverInfoLabel
                      label={row.original.nodeName}
                      hoverInfo="This node is not part of the cluster any more."
                      icon="mdi:alert-outline"
                    />
                  ),
              },
              {
                id: 'count',
                header: 'Logical volumes',
                gridTemplate: 1,
                accessorFn: (row: NodeRow) => row.count,
              },
              {
                id: 'bytes',
                header: 'Total size',
                gridTemplate: 1,
                accessorFn: (row: NodeRow) => row.bytes,
                Cell: ({ row }) => formatBytes(row.original.bytes),
              },
              {
                id: 'withoutPersistentVolume',
                header: 'Without a PV',
                gridTemplate: 1,
                accessorFn: (row: NodeRow) => row.withoutPersistentVolume,
              },
              {
                id: 'free',
                header: 'Free in volume group',
                gridTemplate: 1.4,
                accessorFn: (row: NodeRow) =>
                  Object.values(row.freeByDeviceClass).reduce((sum, bytes) => sum + bytes, 0),
                Cell: ({ row }) => {
                  const classes = Object.entries(row.original.freeByDeviceClass);
                  if (classes.length === 0) {
                    return NOT_AVAILABLE;
                  }
                  const total = classes.reduce((sum, [, bytes]) => sum + bytes, 0);
                  return (
                    <HoverInfoLabel
                      label={formatBytes(total)}
                      hoverInfo={classes
                        .map(([name, bytes]) => `${name}: ${formatBytes(bytes)} free`)
                        .join(', ')}
                    />
                  );
                },
              },
            ]}
          />
        </SectionBox>
      )}
    </>
  );
}
