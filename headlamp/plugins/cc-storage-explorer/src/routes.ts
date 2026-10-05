/**
 * Route and sidebar identifiers used across the plugin.
 *
 * The names are used with `createRouteURL`/`Link`, so they must stay in sync
 * with what is passed to `registerRoute` in `index.tsx`.
 */

/** Sidebar entry added under the built-in "Storage" menu. */
export const SIDEBAR_ENTRY_NAME = 'ccNodeStorage';

export const OVERVIEW_ROUTE_NAME = 'ccNodeStorageOverview';
export const OVERVIEW_ROUTE_PATH = '/cc-storage-explorer/nodes';

export const DETAILS_ROUTE_NAME = 'ccNodeStorageDetails';
export const DETAILS_ROUTE_PATH = '/cc-storage-explorer/nodes/:nodeName';

/** Sidebar entry for the TopoLVM logical volume views. */
export const LOGICAL_VOLUMES_SIDEBAR_ENTRY_NAME = 'ccLogicalVolumes';

export const LOGICAL_VOLUMES_ROUTE_NAME = 'ccLogicalVolumes';
export const LOGICAL_VOLUMES_ROUTE_PATH = '/cc-storage-explorer/logicalvolumes';
