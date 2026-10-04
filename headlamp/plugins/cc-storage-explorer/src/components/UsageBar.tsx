import Box from '@mui/material/Box';
import LinearProgress from '@mui/material/LinearProgress';
import Typography from '@mui/material/Typography';
import { formatPercent, NOT_AVAILABLE, usageSeverity } from '../lib/format';

export interface UsageBarProps {
  /** Usage ratio in [0, 1], or null when it is not known. */
  fraction: number | null;
}

/** A compact usage bar meant for table cells. */
export default function UsageBar({ fraction }: UsageBarProps) {
  if (fraction === null) {
    return <Typography variant="body2">{NOT_AVAILABLE}</Typography>;
  }

  const severity = usageSeverity(fraction);
  const color = severity === 'ok' ? 'primary' : severity === 'warning' ? 'warning' : 'error';

  return (
    <Box display="flex" alignItems="center" gap={1} minWidth="7rem">
      <LinearProgress
        variant="determinate"
        value={fraction * 100}
        color={color}
        sx={{ flexGrow: 1, height: 8, borderRadius: 4 }}
      />
      <Typography variant="body2" sx={{ minWidth: '2.5rem', textAlign: 'right' }}>
        {formatPercent(fraction)}
      </Typography>
    </Box>
  );
}
