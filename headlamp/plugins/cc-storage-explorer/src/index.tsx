/**
 * cc-storage-explorer
 *
 * Adds "Node Storage" and "Logical Volumes" views under Headlamp's Storage
 * menu, showing how full each node's local disks are, which PersistentVolumes
 * live on them, and the TopoLVM logical volumes behind those PVs.
 */
import { registerRoute, registerSidebarEntry } from '@kinvolk/headlamp-plugin/lib';
import LogicalVolumesOverview from './components/LogicalVolumesOverview';
import NodeStorageDetails from './components/NodeStorageDetails';
import NodeStorageOverview from './components/NodeStorageOverview';
import {
  DETAILS_ROUTE_NAME,
  DETAILS_ROUTE_PATH,
  LOGICAL_VOLUMES_ROUTE_NAME,
  LOGICAL_VOLUMES_ROUTE_PATH,
  LOGICAL_VOLUMES_SIDEBAR_ENTRY_NAME,
  OVERVIEW_ROUTE_NAME,
  OVERVIEW_ROUTE_PATH,
  SIDEBAR_ENTRY_NAME,
} from './routes';

registerSidebarEntry({
  parent: 'storage',
  name: SIDEBAR_ENTRY_NAME,
  label: 'Node Storage',
  url: OVERVIEW_ROUTE_PATH,
});

registerRoute({
  path: OVERVIEW_ROUTE_PATH,
  sidebar: SIDEBAR_ENTRY_NAME,
  name: OVERVIEW_ROUTE_NAME,
  exact: true,
  component: () => <NodeStorageOverview />,
});

registerRoute({
  path: DETAILS_ROUTE_PATH,
  sidebar: SIDEBAR_ENTRY_NAME,
  name: DETAILS_ROUTE_NAME,
  exact: true,
  component: () => <NodeStorageDetails />,
});

registerSidebarEntry({
  parent: 'storage',
  name: LOGICAL_VOLUMES_SIDEBAR_ENTRY_NAME,
  label: 'Logical Volumes',
  url: LOGICAL_VOLUMES_ROUTE_PATH,
});

registerRoute({
  path: LOGICAL_VOLUMES_ROUTE_PATH,
  sidebar: LOGICAL_VOLUMES_SIDEBAR_ENTRY_NAME,
  name: LOGICAL_VOLUMES_ROUTE_NAME,
  exact: true,
  component: () => <LogicalVolumesOverview />,
});
