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

## Object storage: SeaweedFS

| File | What it is |
|---|---|
| `SeaweedFS/SeaweedFS.namespace.yaml` | Its namespace, labelled so the cluster Gateway takes its listeners. |
| `SeaweedFS/SeaweedFS.yaml` | The cluster, as a `Seaweed` resource, and the grant saying which namespaces may keep buckets in it. |
| `SeaweedFS/SeaweedFS.network.yaml` | S3 on `values.domain.storage`, through the cluster Gateway. |

[SeaweedFS](https://github.com/seaweedfs/seaweedfs) provides
S3-compatible object storage. It's run by the
[SeaweedFS operator](https://github.com/seaweedfs/seaweedfs-operator),
which the `seaweedfs` package installs into the `seaweedfs` namespace
(chart 0.1.43, pinned), and the cluster is the `Seaweed` resource
`seaweed` in the same namespace.

It's the smallest cluster the operator makes: one master, one volume
server, one filer and one S3 gateway, keeping one copy of everything.
It's a single point of failure on purpose, as a starting point that's
easy to verify before anything is spread across machines.

- **Storage**: three claims on `cc-local-ssd-fast`. The volume
  server's holds the data and is sized from
  `storage.allocations.objectStorageGb` (see below). The master's
  (1 GiB) and the filer's (5 GiB) hold the cluster's state and the
  names of everything stored, and are fixed. Because the volumes are
  local, each pod stays on the node where its claim was first made.
- **Access**: S3 on `seaweed-s3.seaweedfs.svc:8333` inside the
  cluster, which is what applications talk to. Buckets are addressed
  by path, and SeaweedFS accepts whatever region a request is signed
  for, so clients can leave theirs at `us-east-1`. The manifests read
  both from `.Values.objectStorage`.
- **From outside**: the same S3 on `values.domain.storage`, with a
  certificate from cert-manager. It's there for links applications
  sign and hand to browsers — Authentik's web interface loads icons
  and backgrounds straight from its bucket. No bucket is readable
  anonymously, so every request there needs keys, or a link signed
  with them. Lago and Twenty send their files on themselves instead,
  and never hand out a link to SeaweedFS.
- **Version**: SeaweedFS itself is pinned in the resource, since the
  operator doesn't choose one.

### Buckets

An application doesn't use any cluster-wide key. It asks for its own
bucket and keys to only that bucket, with three of the operator's
resources in its own namespace:

- a `Bucket`, naming who may do what with it;
- an `S3Identity`, the user those keys belong to;
- an `S3Credentials`, which has the operator make a key pair and
  write it into a Secret beside it, under `accessKey` and
  `secretKey`.

`k8s/apps/lago/Lago.bucket.yaml` is the example, and Twenty's and
Authentik's `*.storage.yaml` are the same shape. The package lists
the bucket and the credentials under `ready`, so the install waits for
the operator to finish before it waits for the application.

These point at a cluster in another namespace, which the operator
refuses unless a `ResourceReferenceGrant` in `seaweedfs` allows it.
The grant in `SeaweedFS.yaml` lets in any namespace labelled
`storage.community-cloud.technology/buckets: "true"`, which `cc-office`
is. Another namespace gets buckets by carrying the label too.

A bucket outlives its resource: the operator's default is to keep it
and everything in it. The user and its keys don't, so removing an
application's resources revokes its access and keeps its files.

Two settings in `SeaweedFS.yaml` are less obvious than they look.
Every bucket is a collection of volume files of its own, and the
volume server sizes how many it can hold from its disk. At
SeaweedFS's default of 30 GB a volume, a 50 GiB disk would have room
for one bucket, so the limit is 1 GiB. And a new bucket is given seven
volumes at a time by default, which with one copy of everything fills
those slots after about seven buckets, so it's two.

### Not yet

- **Signing in through Authentik.** The operator has an
  `S3OIDCProvider` resource for handing out S3 keys to people signed
  in elsewhere, but in this release it isn't wired up and is switched
  off. The other way SeaweedFS can do it, a fixed IAM file, freezes the
  store the per-application keys live in. Its admin UI has a password
  of its own and isn't installed.
- **Backups.** The operator can snapshot the filer's metadata on a
  schedule, and mirror the data elsewhere. Neither is set up.
- **Other storage classes.** It's SSD for now. SeaweedFS can tier
  volumes by disk type, which could put cold data on `hdd`, but that
  needs investigating first.
- **More than one node.** That means more replicas, a replication
  setting other than `000`, and a filer store shared between filers.

## How much each service gets

The services that claim local storage share the same volume groups,
so their sizes are set together in the installer configuration
rather than in each manifest:

```json
"storage": {
  "allocations": { "databaseGb": 30, "objectStorageGb": 50 }
}
```

| Key | For | Default |
|---|---|---|
| `databaseGb` | The shared Postgres cluster, `cc-postgres` | 30 |
| `objectStorageGb` | SeaweedFS's volume server | 50 |

The manifests read these back as `.Values.databaseVolumeSize` and
`.Values.objectStorageVolumeSize`. The classes allow expansion, so a
size can be raised and the claim grows to match on the next install.
A size can't be lowered. The sum has to fit on the storage nodes,
along with the 6 GiB SeaweedFS's master and filer claim. A
claim bigger than the volume group behind it doesn't fail. It waits,
with its pod stuck in Pending.

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
