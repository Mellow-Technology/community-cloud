# cc-storage-explorer

A [Headlamp](https://headlamp.dev) plugin that shows how full each node's local
disks are, which PersistentVolumes live on those disks, and the TopoLVM logical
volumes behind them.

It appears in the sidebar as **Storage → Node Storage** and
**Storage → Logical Volumes**.

## What it shows

### Overview (`/cc-storage-explorer/nodes`)

- A gauge per node for the root filesystem (`nodefs`), plus one for the cluster
  total, so you can see at a glance which node is filling up. Gauges turn amber
  above 75% and red above 90%.
- A node table with capacity, used, available, a usage bar, inode usage,
  `ephemeral-storage` allocatable, the number of node-local PVs, and the node's
  `DiskPressure` condition.
- A table of every node-local PersistentVolume in the cluster.

### Node details (`/cc-storage-explorer/nodes/<node>`)

- Gauges for the root filesystem, the image filesystem (`imagefs`, only when it
  is a separate device) and inodes.
- The node's storage facts as a name/value table, including the free capacity of
  each TopoLVM device class.
- The node-local PersistentVolumes pinned to that node, with live usage for the
  ones that are bound to a claim.
- The TopoLVM logical volumes in that node's volume group.
- Pods on the node ranked by ephemeral storage usage.

### Logical volumes (`/cc-storage-explorer/logicalvolumes`)

- Two gauges: the share of logical volumes with no PersistentVolume, and the
  share of the space they take. Both measure what is *unclaimed* rather than what
  is in use, so that they follow the same severity scale as every other gauge
  here — a fuller ring is a worse state. Drawn the other way round, a ring would
  fill up as volumes found a home and turn amber for a healthy cluster.
- A table of every logical volume: the node it lives on, its device class, its
  size on disk versus the size requested, the PersistentVolume using it, that
  PV's claim, and its state.
- A per-node roll-up: volume count, total size, how many lack a PV, and the
  remaining capacity of the node's volume group.

The view is empty with an explanatory note on clusters that do not run TopoLVM.

## Where the numbers come from

Live usage is read from the kubelet Summary API through the API server:

```
GET /api/v1/nodes/<node>/proxy/stats/summary
```

That endpoint requires the `nodes/proxy` resource in RBAC. When it is not
readable the views still render: gauges show "usage unavailable" and fall back to
the `ephemeral-storage` capacity advertised on the Node object, and an
explanatory banner is shown. Stats are refreshed every 30 seconds
(`REFRESH_INTERVAL_MS` in `src/lib/nodeStorage.ts`).

TopoLVM logical volumes are read from the cluster-scoped `LogicalVolume` custom
resource (`topolvm.io/v1`), which is the only place the node placement
(`spec.nodeName`) and the on-disk size (`status.currentSize`) appear. A logical
volume is matched to its PersistentVolume by CSI volume handle — TopoLVM writes
the same value into the PV's `spec.csi.volumeHandle` and the volume's
`status.volumeID` — falling back to name equality, since dynamically provisioned
volumes are named after the PV. A volume with no match still occupies space in
the node's volume group but nothing in Kubernetes refers to it.

Per-node volume group capacity comes from TopoLVM's own
`capacity.topolvm.io/<device-class>` node annotations, which report the space
*remaining* in each volume group. Note this is a different disk from the one the
Node Storage gauges measure: those read the kubelet's root filesystem, while
logical volumes are carved out of the LVM volume group.

A PersistentVolume is treated as node-local when it uses the `local` or
`hostPath` volume source, or when its `nodeAffinity` pins it to one or more of
the cluster's nodes. Rather than hard-coding topology keys, every `In` value in
the affinity is matched against the real node names, so local-storage CSI
drivers (local-path-provisioner, OpenEBS LocalPV, TopoLVM, …) are picked up
without per-driver knowledge.

## Layout

```
src/
├── index.tsx                       # sidebar entry + route registration
├── routes.ts                       # route names and paths
├── lib/
│   ├── format.ts                   # byte/percent formatting, usage thresholds
│   ├── nodeStorage.ts              # kubelet summary API access and view models
│   ├── localVolumes.ts             # node-local PV detection
│   ├── logicalVolumes.ts           # TopoLVM LogicalVolume CR and PV matching
│   └── nodeNames.ts                # stable React dependency for a node name set
└── components/
    ├── NodeStorageOverview.tsx     # the overview page
    ├── NodeStorageDetails.tsx      # the per-node page
    ├── LogicalVolumesOverview.tsx  # the logical volumes page
    ├── LogicalVolumesTable.tsx     # shared logical volume table
    ├── LocalVolumesTable.tsx       # shared PV table
    ├── StorageGauge.tsx            # TileChart wrapper
    ├── GaugeGrid.tsx               # responsive gauge layout
    └── UsageBar.tsx                # compact in-table usage bar
```

The UI is built from Headlamp's own components (`SectionBox`, `Table`,
`NameValueTable`, `TileChart`, `Link`, `StatusLabel`, `Loader`) so it matches the
rest of the interface and follows the active theme.

## Installing

Headlamp loads a plugin from a folder containing **both** `main.js` and
`package.json` inside its plugins directory. Build and copy them with:

```bash
npm run build && npm run deploy:local
```

Then reload Headlamp (Cmd/Ctrl+R).

The destination differs per platform, and the desktop app can be started with a
different one via `--plugins-dir` (check with `ps aux | grep headlamp-server`):

| Platform | Default plugins directory |
| --- | --- |
| macOS (desktop app) | `~/Library/Application Support/Headlamp/plugins` |
| Linux | `~/.config/Headlamp/plugins` |
| Windows | `%APPDATA%\Headlamp\Config\plugins` |

Set `HEADLAMP_PLUGIN_DIR` to override where `deploy:local` copies to.

To confirm the backend sees it, ask the running server (port 4466 by default);
the plugin should appear with type `development`:

```bash
curl -s http://localhost:4466/plugins
```

## Development

```bash
npm install
npm run check && npm run build && npm run deploy:local
```

Then reload Headlamp.

`npm run check` runs the type check, the lint and the formatting check. The
scripts call `tsc`, `eslint`, `prettier` and Vite directly rather than going
through the `headlamp-plugin` CLI, which does not run on Node 26 — it fails
inside yargs with `ReferenceError: require is not defined in ES module scope`.

That also rules out `headlamp-plugin`'s `start` (watch mode), `package`,
`storybook`, `test` and `i18n`, so there are no scripts for them; on an older
Node they can be run with `npx @kinvolk/headlamp-plugin <command>`. Without watch
mode, a change means `npm run build && npm run deploy:local` and a reload.

## Code conventions

The modules under `src/lib` follow the installer's conventions: a `@file`
block at the top saying what the module is for and why it works the way it
does, `@param`/`@returns` on exported functions, and a comment above each
constant giving the reason for its value rather than restating it.

Formatting is the one place they diverge. The installer is hand-formatted with
double quotes; this plugin is checked by Headlamp's own Prettier and ESLint
config (`@headlamp-k8s/eslint-config`, single quotes, 100 columns), which
`npm run lint` enforces. Matching the installer's quote style would mean
fighting the plugin's own toolchain on every save.
