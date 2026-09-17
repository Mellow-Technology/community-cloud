# Community Cloud — Storage

Local block storage, the classes that expose it, and object storage.

## Local storage: TopoLVM

TopoLVM is a CSI driver that hands a pod a logical volume from a
volume group on the node it's scheduled to. Local storage rather than
distributed: it's simpler, it's faster, and most applications would
rather have speed than the ability to move a volume between machines.
Anything that needs its data in more than one place — a database with
replicas, object storage — handles that itself.

| File | What it is |
|---|---|
| `TopoLVM/TopoLVM.values.yaml` | TopoLVM's Helm values, and where the device classes are defined. |

### Device classes

Storage performance should be predictable rather than a lottery. A
database asking for fast storage shouldn't land on a spinning disk
because that's what had room. So volumes are carved out of a volume
group chosen for what the disks in it actually are:

| Device class | Volume group | For |
|---|---|---|
| `ssd` | `cc-ssd-vg` | NVMe. The fastest, and the default. |
| `ssd-sata` | `cc-ssd-sata-vg` | Solid state behind a SATA controller. |
| `ssd-cache` | `cc-ssd-cache-vg` | An SSD fronting spinning disks. **Not yet implemented — see below.** |
| `hdd` | `cc-hdd-vg` | Spinning disks. The slowest and the largest. |

This file is the source of truth. The installer reads the device
classes out of it and creates exactly those volume groups, so adding a
class here is all it takes — the names aren't written down anywhere
else.

### How the volume groups get made

`community-cloud run-bundle lvm <node> cc.config.json` looks at every
block device on a node, works out which are free, sorts them by what
they are, and builds the groups.

A disk is only touched if it is demonstrably unused: no partitions, no
filesystem signature, not mounted, nothing holding it, not removable,
not read-only. Anything else is reported with the reason and left
alone. There is no flag to override that — if you meant to reuse a
disk, wipe it yourself first.

Everything the installer creates carries LVM tags: `community-cloud`
on both the physical volumes and the volume groups, plus
`cc-class-<name>` saying which device class it serves. So ownership is
a property of the object rather than a guess from its name:

```bash
sudo vgs @community-cloud     # only ours
sudo pvs @cc-class-hdd        # only the bulk storage
```

Which disks to use can be narrowed per node — see `storage` in the
[installer README](../../installer/README.md#storage).

### On `ssd-cache`

LVM can put an SSD in front of a spinning disk, and the device class
is reserved for that. It isn't implemented, because TopoLVM can't
deliver it: a device class supports only `name`, `volume-group`,
`spare-gb`, `default`, `stripe`, `stripe-size` and `lvcreate-options`,
with no cache support of any kind. An LVM cachevol or cachepool
attaches to exactly one logical volume, so it can't serve a class that
creates volumes on demand.

Doing it properly means caching *below* LVM, where TopoLVM can't see
it — `bcache` or `dm-writecache` over the spinning disk, `pvcreate` on
the result, volume group on top. Every volume in the group is then
transparently cached. That's a kernel module and a device format, so
it's a decision rather than a detail.

## Storage classes

| File | Class | Device class |
|---|---|---|
| `StorageClass/cc-local-ssd-fast.yaml` | `cc-local-ssd-fast` | `ssd` |
| `StorageClass/cc-local-ssd-sata.yaml` | `cc-local-ssd-sata` | `ssd-sata` |

Both use XFS, `Retain`, `allowVolumeExpansion`, and
`WaitForFirstConsumer` — which matters for local storage, since the
volume can only be made once the pod's node is known.

`cc-local-ssd-fast` is the cluster default, so a PVC that doesn't ask
for a class gets fast local storage.

`Retain` means deleting a PVC leaves the volume behind. Reclaiming it
is a manual step, on the grounds that losing data is worse than
tidying up by hand.

## Object storage: Garage

| File | What it is |
|---|---|
| `Garage/GarageValues.yaml` | Garage's Helm values. |

[Garage](https://garagehq.deuxfleurs.fr) is S3-compatible object
storage built for exactly this shape of cluster — a handful of
machines in different places, on ordinary connections.

Currently one replica, using `cc-local-ssd-fast` for metadata and
data, with the S3 API on NodePort 3900 and the web interface on 3902.
For anything beyond a single node, raise `replicaCount` and set
`replicationFactor` to match.

## Where nodes come into it

TopoLVM's controller, lvmd and node components all schedule only onto
nodes labelled `node-role.kubernetes.io/storage-local=storage-local`,
which the installer applies from the `roles` on a node. A node without
that role isn't running out of storage — it simply doesn't offer any,
and TopoLVM won't schedule volumes there.

### Nodes that can't serve every class

Not every machine has one of each kind of disk in it, and a Community
Cloud is usually built out of whatever hardware people have. A node
with SSDs and nothing spinning is a perfectly good node for the classes
it does have.

lvmd disagrees. It's handed a list of device classes and refuses to
start unless every volume group in that list is on the node it landed
on, so one missing group means the node serves none of them and
CrashLoopBackOffs:

```
"msg":"volume group not found","volume_group":"cc-hdd-vg","error":"not found"
```

This is stricter than the rest of lvmd needs — its capacity reporting
already iterates the volume groups that exist and skips device classes
it can't place, so a class with no group would simply never be offered.
Only the startup check objects. The exact lines are cited in
`TopoLVM/TopoLVM.values.yaml`, and the real fix is upstream.

Until then the installer works around it. Once a node's volume groups
exist, the `lvm` bundle records which device classes it can serve and
`nodeLabels` puts them on the node as a single label:

```
storage.community-cloud.technology/classes=hdd.ssd
```

Installing the charts then reads those labels back and renders one lvmd
configuration per distinct combination — TopoLVM's `additionalConfigs`
— each offering only the classes those nodes actually have. One per
combination rather than one per class, because a node can only use one
lvmd: `topolvm-node` is given a single socket path. A single label
holding the whole set, rather than one per class, is what keeps the
selectors non-overlapping, which the chart requires.

So run the bundles in that order, and re-run `helm-charts` after the
storage on a node changes:

```bash
community-cloud run-pipeline lvm,nodeLabels <node> cc.config.json
community-cloud run-bundle helm-charts <node> cc.config.json
```

A cluster where nothing has been labelled yet — a first install —
offers every node every class, which is the behaviour from before this
existed. When a node's shape does change it moves between lvmd
DaemonSets, and `topolvm-node` will crash once or twice while the
socket is absent before reconnecting on its own.
