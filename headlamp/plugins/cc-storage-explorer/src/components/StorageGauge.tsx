import { TileChart } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import { useTheme } from '@mui/material/styles';
import React from 'react';
import {
  formatBytes,
  formatPercent,
  usageFraction,
  UsageSeverity,
  usageSeverity,
} from '../lib/format';
import { KubeletFsStats } from '../lib/nodeStorage';

export interface StorageGaugeProps {
  title: React.ReactNode;
  /** Filesystem stats to draw. When usage is missing the gauge shows a hint instead. */
  usage?: KubeletFsStats | null;
  /** Tooltip shown next to the title. */
  infoTooltip?: string | null;
  /** Legend used when there is nothing to draw. */
  unavailableMessage?: string;
  /** Extra text appended under the used/capacity legend. */
  legendSuffix?: string;
  /**
   * The legend, where "x of y used" is the wrong sentence for what is
   * being measured. Takes the place of the default, suffix included.
   */
  legend?: React.ReactNode;
  /** How the used/capacity numbers are rendered. Defaults to binary byte sizes. */
  formatValue?: (value?: number | null) => string;
}

/** Colour of the filled part of a gauge, following the same severity everywhere. */
export function useSeverityColor(severity: UsageSeverity): string {
  const theme = useTheme();

  if (severity === 'critical') {
    return theme.palette.error.main;
  }
  if (severity === 'warning') {
    return theme.palette.warning.main;
  }
  return theme.palette.chartStyles.fillColor || theme.palette.primary.main;
}

/**
 * A Headlamp tile chart showing how full a filesystem is.
 *
 * Falls back to a legend-only tile when the kubelet did not report usage, so
 * the layout stays stable whether or not stats are available.
 */
export default function StorageGauge(props: StorageGaugeProps) {
  const {
    title,
    usage,
    infoTooltip = null,
    unavailableMessage = 'Usage unavailable',
    legendSuffix,
    legend,
    formatValue = formatBytes,
  } = props;

  const capacity = usage?.capacityBytes;
  const used = usage?.usedBytes;
  const fraction = usageFraction(used, capacity);
  const fill = useSeverityColor(usageSeverity(fraction));

  if (fraction === null || capacity === undefined) {
    return (
      <TileChart title={title} infoTooltip={infoTooltip} legend={unavailableMessage} data={null} />
    );
  }

  const defaultLegend = `${formatValue(used)} of ${formatValue(capacity)} used${
    legendSuffix ? ` ${legendSuffix}` : ''
  }`;

  return (
    <TileChart
      title={title}
      infoTooltip={infoTooltip}
      legend={legend ?? defaultLegend}
      total={capacity}
      data={[{ name: 'used', value: used as number, fill }]}
      label={formatPercent(fraction)}
    />
  );
}
