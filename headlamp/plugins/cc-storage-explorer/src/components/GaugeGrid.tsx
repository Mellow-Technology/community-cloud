import Box from '@mui/material/Box';
import React from 'react';

/** Responsive grid that keeps the storage gauges aligned on any screen width. */
export default function GaugeGrid({ children }: React.PropsWithChildren<{}>) {
  return (
    <Box
      display="grid"
      gridTemplateColumns="repeat(auto-fill, minmax(260px, 1fr))"
      gap={2}
      alignItems="stretch"
    >
      {children}
    </Box>
  );
}
