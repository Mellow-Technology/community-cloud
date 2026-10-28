# Community Cloud Installer

The Community Cloud Installer is a command-line interface (CLI) tool designed to simplify the deployment and configuration of K3s clusters across multiple nodes and sites. Whether you're setting up a single-site environment or managing a distributed multi-site infrastructure, this installer provides an automated, reliable way to get your cluster up and running.

## Key Features

- **Multi-Node, Multi-Site Deployment**: Seamlessly configure K3s across multiple nodes and sites with minimal manual intervention.
- **Automatic Storage Configuration**: The installer automatically sets up and configures storage solutions using [TopoLVM](https://github.com/topolvm/topolvm), providing dynamic volume provisioning and snapshot capabilities tailored to your cluster's needs.
- **Database Support**: PostgreSQL through CloudNativePG, as one shared `cc-postgres` cluster the applications each get a role and a database in.
- **Cross-Site Networking**: Nodes on different networks reach each other over a [Nebula](https://github.com/slackhq/nebula) mesh, managed through Defined Networking, so a cluster can span several sites.
- **Tailscale**: Optionally, the Tailscale operator exposes cluster services on a tailnet.
- **Scalable Architecture**: Easily scale your cluster by adding more nodes or sites as your requirements grow.

## Use Cases

- Deploying a multi-node K3s cluster for edge computing environments
- Setting up a distributed cluster across multiple physical locations
- Configuring GPU-enabled nodes for machine learning workloads
- Establishing secure cross-site communication for hybrid cloud setups

## Getting Started

Build a configuration and check it, then install:

```bash
community-cloud                              # build a configuration
community-cloud preflight cc.config.json     # check it could work
community-cloud install cc.config.json       # build the cluster
community-cloud doctor cc.config.json        # ask the cluster how it's doing
```

For how the pieces fit together, see the [documentation index](../docs/index.md).

## Configuration

Everything the installer does comes from one JSON file, conventionally
`cc.config.json`. Every command takes its path:

```bash
community-cloud preflight cc.config.json
community-cloud run-bundle k3s phoenix cc.config.json
community-cloud doctor cc.config.json
```

You don't have to write it by hand. `community-cloud` with no
arguments walks through building one, and can edit an existing file:

```bash
community-cloud                      # build or edit a configuration
community-cloud configure --section nodes
community-cloud configure --all      # every section in turn, not the menu
```

**The file holds secrets** — the cluster token, registry passwords, a
Nebula API key, mail passwords, DNS provider credentials — so it's
gitignored here as `*.config.json`. What the
installer records *in* the cluster has those stripped out; see
[Secrets in commands](#secrets-in-commands).

What the file can hold is described by a JSON Schema,
[`cc.config.schema.json`](cc.config.schema.json). Point the file at it
with `"$schema"`, as the example below does, and an editor will
complete keys, explain them, and flag mistakes as you type. The path is
relative to the configuration file. Preflight, `install` and
`add-node` refuse what the schema rules out, and they and the doctor
warn about keys it doesn't know, so nothing depends on the editor (see
[Checking a configuration](#checking-a-configuration)).

### A small complete example

```jsonc
{
  "$schema": "./installer/cc.config.schema.json",

  "k3s": { "token": "a-long-shared-secret" },

  "values": {
    "adminEmail": "you@example.com",
    "domain": { "main": "example.com" }
  },

  "network": {
    "congestionControl": "bbr",
    "gateway": {
      "mode": "port-forward",
      "addresses": ["192.168.1.240-192.168.1.250"]
    }
  },

  "packages": { "cert-manager": true, "cloudnative-pg": true },

  "nodes": [
    {
      "name": "server-1",
      "address": "server-1.local",
      "username": "kyle",
      "type": "server",
      "gateway": true,
      "roles": ["worker", "storage-local"],
      "region": "eur",
      "zone": "eur-de-1"
    }
  ]
}
```

### `nodes`

The only required section. Each entry is one machine.

| Key | Meaning |
|---|---|
| `name` | What to call it. Also how it registers in the cluster, when it can be a DNS label. |
| `displayName` | What to print it as, when that isn't its `name`: `"Mamoru (Bangkok)"` for `mamoru-bkk`. Only what the installer prints changes. On the command line, and everywhere else, the node is still its `name`. |
| `address` | How to reach it over SSH. Often an alias from `~/.ssh/config` rather than a name DNS knows. |
| `type` | `server` or `agent`. Exactly one node should be a `server`. |
| `username` | The SSH user. Needs passwordless sudo to root for any command, not just some, and without `requiretty` — preflight and the doctor both check. |
| `keyFile` | A private key path. Otherwise the usual `~/.ssh` keys and your agent are tried. |
| `port` | SSH port, when it isn't 22. |
| `apiAddress` | Where *other nodes* reach this one's Kubernetes API, when that differs from `address`. A bastion or port forward gets you to a node without being a name the cluster can use. |
| `nodeName` | What to register as in the cluster, when `name` and `address` can't be DNS labels. `"Mamoru BKK"` and `10.0.0.5` both can't. |
| `nodeIp` | The address it registers on, which the other nodes reach its pods through. On a cluster using Nebula, its address on the mesh, found on the node; otherwise the address of its default route. See [Nodes across sites](#nodes-across-sites). |
| `nodeExternalIp` | The address it's reached at from outside, such as a gateway's public address. Nothing on a node says which of its addresses is the outside, so K3s can't work this out. |
| `gateway` | `true` if the outside world can reach this node. See `network.gateway`. |
| `roles` | What it's for: `worker`, `worker-gpu`, `storage-local`, `storage-distributed`, `storage`, `gateway`, `lighthouse`. Applied as `node-role.kubernetes.io/<role>` labels, which is what the manifests in `k8s/` select on. |
| `labels` | Anything else worth labelling it with, as key/value pairs. |
| `region`, `zone` | Where it physically is, put on the node as `topology.kubernetes.io/region` and `zone`. Kubernetes spreads workloads across zones, and [`placement`](#placement) keeps a namespace in a region. Region codes are fixed — see `src/topology/regions.ts`. |
| `storage` | Per-node storage settings, overriding the cluster-wide `storage` section. |
| `nebula` | Per-node mesh settings: `role`, `listenPort`, `staticAddresses`, `isLighthouse`, `isRelay`. |

Some roles are worked out rather than written down: a node with a GPU
gets `worker-gpu`, and one with `"gateway": true` gets `gateway`.

### `k3s`

| Key | Default | Meaning |
|---|---|---|
| `token` | — | The cluster token. The server and every agent need the same one. Required. |
| `version` / `channel` | current stable | Pin the K3s release. The doctor reports any node whose kubelet is on a different `version`, such as one the k3s bundle never reached. |
| `clusterCidr` | `10.42.0.0/16` | The pod network. Wants to agree with the Cilium values. |
| `disable` | — | Packaged components to leave out, e.g. `metrics-server`. `traefik`, `servicelb` and `local-storage` are *always* left out whatever this says — Cilium's Envoy serves the Gateway API, Cilium's own IP management hands out load balancer addresses, and TopoLVM provisions local volumes. K3s's local-path provisioner also claims to be the default storage class, and Kubernetes allows only one. |
| `extraServerArgs`, `extraAgentArgs` | — | Anything else to pass through. |
| `signInClients` | — | Clients in Authentik, besides Headlamp's, whose tokens the API server accepts — `{ "application": "<slug>", "clientId": "<id>" }` each, such as one made for kubectl. See [signing in to the cluster](#signing-in-to-the-cluster). |
| `kubeconfig` | `/etc/rancher/k3s/k3s.yaml` | Where kubectl should look, for a cluster this didn't build. |

### `network`

Kernel networking settings sit at the top of this section; everything
else is a subsection.

| Key | Default | Meaning |
|---|---|---|
| `congestionControl` | `bbr` | TCP congestion control. BBR holds throughput up over links that lose the odd packet, which CUBIC reads as congestion. |
| `qdisc` | `fq` | The default queueing discipline. BBR wants a fair-queueing one underneath it. |
| `congestionModule` | `tcp_<algorithm>` | The kernel module, when it isn't named after the algorithm. |

Most kernels ship BBR as a module that isn't loaded until something
asks for it, so a kernel only lists it as available once it is.
Preflight and the doctor count a module that's there as support, since
they load nothing. The `network` bundle loads it, loads it on every boot
from then on (`/etc/modules-load.d/community-cloud.conf`), and makes it
the default with sysctl (`/etc/sysctl.d/99-community-cloud-network.conf`).
Until it has run, the doctor reports the node still on its old
algorithm.

#### `network.cilium`

| Key | Default | Meaning |
|---|---|---|
| `version` | `1.20.1` | The Cilium release. |
| `cliVersion` | `v0.20.0` | The Cilium CLI. `"stable"` takes whatever is current instead. |
| `gatewayApiVersion` | `v1.6.1` | The Gateway API release. Pinned deliberately: a mismatched pair fails quietly. |
| `kubeProxyReplacement` | `true` | Whether Cilium takes over from kube-proxy. K3s reads this too. |
| `valuesFile` | the embedded one | Override the Cilium values. |

#### `network.gateway`

How the outside world reaches the cluster. The `gateway` bundle turns
this into a Cilium address pool, and on a home network an ARP
announcement policy as well.

| Key | Meaning |
|---|---|
| `mode` | `floating` — the address is already on an interface of a gateway node, routed there by a provider. `port-forward` — a router maps ports to a LAN address nothing holds, and Cilium answers ARP for it. |
| `addresses` | What a LoadBalancer Service may be given: `"203.0.113.10"`, `"10.0.0.0/29"`, or `"192.168.1.240-192.168.1.250"`. |
| `interfaces` | `port-forward` only. Which interfaces to answer ARP on, as regular expressions. Defaults to every local interface. |
| `name` | What to call the pool and policy. Defaults to `community-cloud-gateway`. |

#### `network.externalIPs`

Addresses a particular node holds, as node name to address. This is
the floating case written per node, and the node must be a gateway.

```jsonc
"externalIPs": { "Brahma": "203.0.113.10" }
```

#### `network.nebula`

A Defined Networking mesh, for nodes that can't reach each other
directly.

| Key | Meaning |
|---|---|
| `apiKey` | A Defined Networking API key. Falls back to the `DEFINED_API_KEY` environment variable. |
| `network` / `networkID` | Which network, by name or by ID. |
| `defaultRole` | The role nodes enrol under. |
| `roles` | Roles to create: `name`, `description`, and `firewallRules` of `protocol` (`ANY`/`TCP`/`UDP`/`ICMP`), `allowedRole` or `allowedTags`, and `portRange`. |

#### Nodes across sites

Every node registers in the cluster on one address, and that address
is what the rest of the cluster reaches it on: Cilium tunnels pod
traffic between nodes' registered addresses. Left to itself, K3s picks
the address of the default route — on a machine behind a router at
home, its LAN address, which a node at another site can't reach. Pods
on the two would never meet.

So on a cluster using Nebula, the `k3s` bundle first finds each
node's address on the mesh (`find-node-ip`, on its `defined*`
interface) and installs K3s with `--node-ip` set to it. A node that
isn't on the mesh stops the install there rather than registering on
its LAN address; run the `nebula` bundle on it first. `nodeIp` on a
node overrides the mesh address, and is checked to be one the node
has. Afterwards `verify-node-ip` asks the cluster which addresses it
actually has the node on — the doctor asks too, so a node registered
somewhere else is found.

The server is joined at its `apiAddress`, or its `address`, so on a
cluster across sites that should be an address on the mesh as well.

### `storage`

Which disks TopoLVM may carve volumes out of. Can also be set per
node, which is usually where it belongs — nodes differ in their disks
more than in anything else.

| Key | Meaning |
|---|---|
| `disks` | Consider only these, by path. This **narrows** what's considered; it never overrides a safety check. |
| `diskClasses` | Put a disk in a class other than the one its hardware suggests: `{"/dev/sdb": "hdd"}`. |
| `minimumSizeGb` | Ignore disks smaller than this. Defaults to 1. |
| `allocations` | How much each service claims, in whole GiB: `databaseGb` (default 30) and `objectStorageGb` (default 50, per SeaweedFS volume server). Read from the cluster-wide section only. |
| `objectStorage` | SeaweedFS's shape: `masters` (odd), `volumeServers` (one per `storage-local` node) and `copies` (no more than `volumeServers`). One of each by default. See [Object storage](../k8s/storage/README.md#object-storage-seaweedfs). |

Disks are sorted by what they are — NVMe to `ssd`, other solid state
to `ssd-sata`, spinning to `hdd` — and the volume group each class
lands in comes from the TopoLVM values file. A disk is only ever
touched if it is demonstrably unused: no partitions, no filesystem
signature, not mounted, nothing holding it, not removable, not
read-only. Anything else is reported and left alone.

A node doesn't have to have a disk of every class. What it ends up
serving is recorded on the node by `nodeLabels`, and the TopoLVM values
are rendered from those labels so that a node is never offered a volume
group it hasn't got — which lvmd treats as fatal. That means running
`lvm` and `nodeLabels` before `helm-charts`, and re-running
`helm-charts` when a node's disks change. See
[Nodes that can't serve every class](../k8s/storage/README.md#nodes-that-cant-serve-every-class).

`allocations` is about the volumes rather than the disks. The
database and SeaweedFS both claim space from the same volume groups,
so their sizes are set side by side, and together they have to fit.
A size can be raised later and the claim will grow. A size can't be
lowered. See
[How much each service gets](../k8s/storage/README.md#how-much-each-service-gets).

### `placement`

Which region each namespace's pods run in:

```json
"placement": { "cc-office": "sea" }
```

A cluster can span regions and stay one cluster, but workloads that
talk to each other belong together. An application in one region
querying its database in another pays the distance on every query —
Plane's API in Germany, against cc-postgres in Thailand, took six
seconds for a simple request.

The `placement` bundle annotates each namespace listed for Kubernetes'
`PodNodeSelector` admission plugin, which the `k3s` bundle turns on for
the API server when anything is placed. Every pod made in the
namespace then gets a node selector on `topology.kubernetes.io/region`,
including the ones operators make — Postgres, Redis, RabbitMQ — so
nothing in an application's manifests has to know. A region comes from
each node's `region`, which `nodeLabels` puts on the node.

It's strict: with no node in the region up, a pod waits rather than
starting somewhere else. And it only applies to pods made after it, so
placing a namespace that already has workloads leaves them where they
are until they're restarted. The doctor lists any running outside
their region. On a cluster that's already running:

```bash
community-cloud run-bundle k3s <server> cc.config.json   # turns the plugin on; restarts K3s
community-cloud run-bundle nodeLabels all cc.config.json
community-cloud run-bundle placement <server> cc.config.json
```

Preflight reports a namespace placed in a region no node is in.

### `packages`

Which packages to install: Helm charts, or applications made of
manifests alone. `true` is shorthand for enabled, and
`"enabled": false` turns one off while keeping its settings.

```jsonc
"packages": {
  "cert-manager": true,
  "cloudnative-pg": true,
  "topolvm": { "enabled": true, "version": "15.5.2" }
}
```

In the catalogue: `cert-manager`, `cloudnative-pg`, `topolvm`,
`seaweedfs`, `redis-operator`, `rabbitmq-operator`,
`mattermost-operator`, `headlamp`, `tailscale-operator`, `twenty`,
`lago`, `documenso`, `mattermost`, `picoclaw`, `plane`, `cirrus`.
Dependencies
are worked out and installed first — TopoLVM needs cert-manager, so
enabling it enables that too. `cloudnative-pg`, `redis-operator` and
`seaweedfs` each need TopoLVM, so enabling any of them brings TopoLVM
and cert-manager; `rabbitmq-operator` needs both directly.

Applications go in `cc-office`, along with the Postgres, Redis and
RabbitMQ they share. What runs the cluster goes in `community-cloud`:
Headlamp, and operators, since one operator serves every namespace. The exception is an operator whose project gives it a
namespace of its own: cert-manager, `cnpg-system`, `rabbitmq-system`,
`topolvm-system`, `seaweedfs` and `tailscale`.

`cert-manager` also applies `cc-lets-encrypt`, the ClusterIssuer every
application's certificate comes from, with `values.adminEmail` as the
Let's Encrypt account. The Gateway those certificates are for,
`cc-letsencrypt-web-gateway`, is made by the `gateway` bundle, which
runs before the charts.

`seaweedfs` installs the SeaweedFS operator and, through it, the
cluster's S3-compatible object storage. Applications get a bucket
each, and keys to only that bucket, which the operator writes into a
Secret in their namespace. They talk to it inside the cluster; it's
also on `values.domain.storage`, for the links Authentik hands
browsers to its icons and backgrounds. Those links aren't signed, so
Authentik's bucket can be read anonymously, by object name only; every
other bucket needs keys or a link signed with them. See
[Object storage](../k8s/storage/README.md#object-storage-seaweedfs).

`redis-operator` installs the OpsTree Redis operator into
`community-cloud` and, through it, the one Redis the applications in
`cc-office` share, with its password
in the `cc-redis` Secret there.

`rabbitmq-operator` installs the RabbitMQ team's Cluster Operator and
Messaging Topology Operator, vendored at pinned versions in
`k8s/mq/RabbitMQ/` and applied server-side, and through them the one
RabbitMQ the applications in `cc-office` share, `rabbitmq` on 5672. An
application asks for its own vhost and a user limited to it with
`Vhost`, `User` and `Permission` resources, and the operator writes
the user's credentials into `<user>-user-credentials` beside it.

`cirrus` installs Cirrus, Community Cloud's own operator, into
`community-cloud`, with the `WebApplication` resource it runs. A
WebApplication asks for a database, a bucket or a vhost by naming
them, and Cirrus makes them through CloudNativePG, SeaweedFS and the
RabbitMQ topology operator, so the package requires all three. It
also takes GitLab's pipeline webhooks on `values.domain.cirrus` and
rolls out each image a successful pipeline publishes, running the
application's migrations first. See
[operators/cirrus](../operators/cirrus/README.md).

Plane is projects, issues and docs, on `values.domain.plane`, with its
web app, public pages, admin pages and API all on that hostname. Its
database is in cc-postgres, its cache in the shared Redis, its job
queue in a vhost of the shared RabbitMQ, and its files in a SeaweedFS
bucket that browsers reach through Plane's own hostname, at
`/uploads`. Its free edition has no OpenID Connect, so it isn't
signed into through Authentik: sign up is off, and the install makes
its first administrator with `values.adminEmail` and the password in
the `plane-admin` Secret, before anyone else can claim its admin
pages.

`twenty`, `lago`, `documenso`, `mattermost`, `picoclaw` and `plane` are
applications in `cc-office`, each with a ListenerSet of its own on the
cluster Gateway. Any of them can be installed on its own, into a
cluster that already has the rest:

```bash
community-cloud run-bundle lago server-1 cc.config.json
community-cloud run-bundle documenso server-1 cc.config.json
```

Twenty is a CRM, on `values.domain.crm`. Its database is in
cc-postgres, with the `twenty_crm` role CloudNativePG's package makes,
its queues in the shared Redis and its uploads in a SeaweedFS bucket.
The server sets up and migrates the database as it starts. It signs
sessions with the key in `twenty-crm-app-secret` and encrypts stored
credentials with the one in `twenty-crm-encryption-key`, so replacing
the first signs everybody out and loses nothing. To move from an older
encryption key, put it in a `twenty-crm-fallback-encryption-key`
Secret, under `password`: Twenty decrypts with it when the current key
doesn't fit. It sends mail through the namespace's server.

Lago is billing: plans, subscriptions, usage and invoices. Its web app
is on `values.domain.billing` and its API, which the web app calls
from the browser and anything billing through Lago calls too, on
`values.domain.billingApi`. It keeps its database in cc-postgres, its
queues in the shared Redis and its files — invoices, exports, logos —
in a bucket of its own in SeaweedFS, so it brings `cloudnative-pg`,
`redis-operator` and `seaweedfs` with it. Lago has no OpenID Connect,
so it isn't signed into through Authentik: sign up is off, the first
account is made with `values.adminEmail` and a generated password, in
the `lago-admin` Secret, and everyone else is invited from inside
Lago.

Mattermost is team chat, on `values.domain.mattermost`. The
`mattermost-operator` package installs the operator into
`community-cloud`, and enabling `mattermost` enables it too; the
`mattermost` bundle on its own expects the operator already there. It keeps its database in cc-postgres, with the
`mattermost` role CloudNativePG's package makes, and its files in a
bucket in SeaweedFS. The operator wants the database as one connection
string, which the installer builds from that role's credentials into
the `mattermost-db` Secret on every install. It runs one replica:
more needs an Enterprise licence. It isn't signed into through
Authentik, and sends no mail yet.

Documenso is on `values.domain.signing`, and signs people in through
Authentik over OpenID Connect. It needs Authentik running — from the
`authentik` package, or installed by hand as the release `authentik` —
which the install checks for before it starts on it. When the
Authentik package is being installed in the same run, it goes first.
Passwords are switched off, so Authentik is the only way in, and an
account is made for whoever Authentik sends. The people documents are sent to for signing use
their links, without an account. It signs completed documents with a
self-signed certificate the installer makes, in the `documenso-signing`
Secret. It sends email through the cluster's mail server — see
[`smtp`](#smtp) — and without one, signing links are shared by hand.
Making someone a Documenso administrator is done in its database —
add `ADMIN` to their `roles` in the `User` table.

Who may sign in to Documenso is decided in Authentik, by binding
groups or policies to the application. With nothing bound, anyone
with an Authentik account can.

Headlamp, in `community-cloud` on `values.domain.headlamp`, signs in
through Authentik too, and then talks to the Kubernetes API as
whoever signed in; see [signing in to the cluster](#signing-in-to-the-cluster).
Like Documenso, it waits for Authentik. Headlamp's own account has no
permissions. It carries Community Cloud's plugins from
`headlamp/plugins/`, built into the installer with
`bun run build:plugins` then `bun run build:embedded` (see
[Embedded manifests](#embedded-manifests)) and mounted from a
ConfigMap applied before the chart; see
`installer/src/util/headlampPlugins.ts`. Headlamp has no bundle of its
own, so on an existing cluster it's installed or updated with
`run-bundle helm-charts`.

#### Signing in to the cluster

The API server trusts Authentik through an `AuthenticationConfiguration`
the `k3s` bundle writes to `/etc/rancher/k3s/authentication.yaml` on
each server, whenever there's a `values.domain.auth` and a client to
trust it for: Headlamp's, `headlamp`, when the `headlamp` package is
enabled, and any listed in `k3s.signInClients`, such as one made in
Authentik for kubectl. Each Authentik application is its own issuer.
The API server rereads the file when it changes, so adding a client
needs only the `k3s` bundle again; the first one also restarts K3s
with the setting that points at the file.

- People are `authentik:<username>` to the cluster, in
  `authentik:<group>` for each of their Authentik groups. The prefix
  keeps an Authentik group from being taken for one of the cluster's
  own.
- Only members of a group whose name starts `k8s-` get in at all, so
  being in Authentik for some other application isn't enough.
- Members of `values.clusterAdminGroup`, `k8s-admins` by default, are
  cluster admins. Make the group in Authentik; nothing makes it for
  you. Anyone else gets in and sees nothing until a role is bound to
  `authentik:k8s-<their group>`.

See `installer/src/cli/commands/ClusterSignIn.ts`.

A package for something with no sign in of its own can declare a
`gate` instead, and gets an oauth2-proxy in front of it signing in
through Authentik, with the proxy, its credentials and its Authentik
client all made by the installer. See
`installer/src/cli/commands/OAuth2Proxy.ts`. The `picoclaw` package is
the one that does.

A package not in the catalogue needs `repo` and `chart`. Any package
takes `version`, `namespace`, `releaseName`, `valuesFile` (relative to
the working directory), `requires`, `enabled` and `description`.

Applications can also come from plugins rather than the catalogue —
see [`plugins`](#plugins) below.

Some packages bring credentials with them — the database passwords the
applications connect with, for instance. Those aren't configured here;
they're made up during the install. See
[Generated credentials](#generated-credentials).

### `plugins`

Which plugins to load, from `~/.community-cloud/plugins/`. Being in that
directory is not enough: a plugin loads only when the configuration
names it, and only when its fingerprint matches.

```jsonc
"plugins": {
  "mastodon": {
    "enabled": true,
    "sha256": "481ec17bce6555d9ea01cb23ec1bdf6290bb0b7644be562a0fdc298b8bfbd4c2"
  }
}
```

Enable one without a `sha256` and the installer prints everything it
would add — the charts, the manifests, the credentials, and the actual
shell of every command — then refuses to run and gives you the line to
paste. It won't ask again until the plugin changes.

A plugin's packages and bundles are prefixed with its name, so a
plugin called `mastodon` adding a `media` bundle contributes
`mastodon:media`. A thing named after its own plugin isn't doubled:
its package is `mastodon`, not `mastodon:mastodon`. A plugin can't
add a package the installer ships, such as `authentik`.

Plugins are covered properly in [docs/plugins.md](../docs/plugins.md).

### `registries`

Credentials for private registries, keyed by hostname. These end up in
`/etc/rancher/k3s/registries.yaml`, owned by root and readable by
nobody else.

```jsonc
"registries": {
  "registry.gitlab.com": {
    "auth": { "username": "deploy-token", "password": "..." }
  }
}
```

`auth` takes either `username` and `password`, or one of the encoded
forms: `auth` (base64 of `username:password`) or `identityToken`.
`tls` takes `caFile`, `certFile`, `keyFile`, `insecureSkipVerify`.
`endpoint` and `rewrite` are for mirroring.

### `values`

What the manifests under `k8s/` render against. Anything in `values`
is available as `.Values.<path>`. The rest of the configuration is laid
underneath, so `.Values.nodes` is the node list. That works key for key
and doesn't flatten sections: `config.adminEmail` would be
`.Values.config.adminEmail`, which nothing reads. Older configurations
used a `config` section like that, and preflight warns about one, as it
does about the other deprecated keys: a top-level `domains`, and a
node's `sshHost`.

The manifests currently reference `adminEmail`, `domain.main`,
`domain.auth`, `domain.agent`, `domain.crm`, `domain.mattermost`,
`domain.billing`, `domain.billingApi`, `domain.signing`, `domain.plane`,
`domain.headlamp`, `domain.storage`, `clusterAdminGroup` and
`authentik.secretKey`. `clusterAdminGroup` is the Authentik group whose
members are cluster admins through Headlamp or kubectl, `k8s-admins`
unless it's set; it has to start with `k8s-`, which preflight checks.
`authentik.secretKey` signs Authentik's sessions: keep it, since a new
one signs everybody out. Unlike
the rest of the configuration, `values` is open: plugins and your own
manifests can read anything put here, and preflight won't call it
unknown.

Some values are derived rather than written. Setting one replaces what
would have been worked out:

| Key | Derived from |
|---|---|
| `k8sApiServer`, `k8sApiPort` | The control-plane node's `apiAddress` or `address`, and `6443`. |
| `l2Announcements` | The gateway mode: on for `port-forward`. |
| `networkDevices` | The shared interface list. |
| `storageControllerReplicas` | How many TopoLVM controllers run: one per `storage-local` node, at least 1 and at most 2. They insist on separate nodes, so a replica with no node of its own never schedules and the install waits for it forever. Set it to run more on a larger cluster. |
| `mail` | [`smtp`](#smtp), for the namespace being rendered. |
| `databaseVolumeSize`, `objectStorageVolumeSize` | `storage.allocations`: `databaseGb` (30 by default) and `objectStorageGb` (50). |
| `objectStorage` | The cluster's S3 gateway: `endpoint`, `host` (`seaweed-s3.seaweedfs.svc:8333`) and `region`. |
| `clusterAdminGroup` | `k8s-admins`, unless `values.clusterAdminGroup` names another `k8s-` group. |
| `headlampPlugins`, `headlampPluginsRevision` | The Headlamp plugins built into the installer, and a revision that changes with them so Headlamp restarts for a new build. |
| `lvmdBaseSelector`, `lvmdAdditionalConfigs` | The storage node shapes found, one lvmd configuration for each. |

### `smtp`

The mail servers applications send through — invoices, signing
requests, password resets — and which namespaces may send at all.
The servers are assumed to be somewhere else: a provider, or a relay on
your network. Running one well is mostly a matter of reputation, which
a cluster in an office isn't placed to build.

Mail is configured per namespace, each with credentials of its own:

```jsonc
"smtp": {
  // What namespaces share. Never credentials.
  "defaults": {
    "host": "smtp.example.com",
    "port": 587,                 // defaults to the usual port for "security"
    "security": "starttls",      // starttls (587), tls (465) or none (25)
    "fromDomain": "example.com"  // defaults to values.domain.main
  },
  "namespaces": {
    "cc-office": { "username": "office@example.com", "password": "…" },
    "client-acme": {
      "host": "smtp.acme.example", "security": "tls",
      "username": "…", "password": "…"
    }
  }
}
```

The reason is containment. Something that gets into a namespace — a
compromised application, say — finds that namespace's mail credentials
and can start sending. With credentials per namespace, the provider's
rate limits and logs are per namespace, one namespace can be cut off
without touching the rest, and a namespace that isn't listed has
nothing to send with. Taking a namespace out of `namespaces` and running
the install removes the credentials it had; the doctor reports a
namespace still holding credentials it's no longer given. Preflight
reports two namespaces sharing one login, and credentials put in
`defaults`.

It's a little protection rather than a wall: a namespace's credentials
are readable by anything running in it, and nothing here stops a pod
connecting to a mail server of its own.

A namespace naming its own `host` is using a different server, so it
takes nothing from `defaults` but `fromDomain`. Leave out `username`
and `password` for a relay that takes mail without them. Applications
send as an address at `fromDomain` — `billing@`, `documents@`,
`auth@` — so most providers will want that domain verified first.
Lago can only upgrade a connection with STARTTLS, so its namespace's
server can't be one that wants TLS from the start; preflight says so.

Each application is told about its own namespace's server in its own
terms: manifests read it as `.Values.mail`, rendered for the namespace
of the package being installed (`run-template --namespace` says which
for a manifest applied by hand). The username and password go into a
`cc-smtp` Secret in that namespace rather than into any manifest. It's
applied, or removed, on every install, in the namespace of each enabled
package that sends mail — so a changed password lands by changing the
file and running the install again, and a namespace with nothing in it
that sends mail gets no Secret even when it's listed. Applications restart for a new
server on their own; for a new password alone, restart them with
`kubectl rollout restart`.

A namespace without mail keeps it to itself — Twenty, Lago,
Documenso and Plane send nothing. `community-cloud configure --section mail`
asks for all of this, and the doctor checks each namespace's server
can be reached from the cluster.

### `dns`

Publishes the hostnames applications are routed on, through
[ExternalDNS](https://kubernetes-sigs.github.io/external-dns/latest/),
so a name resolves as soon as its route exists — and the Let's Encrypt
challenge after it finds the name already there.

Different domains can live with different providers, and each is
tied to the namespaces allowed to use it: the office applications in
`cc-office` publish the office's domain, and a client or team given a
namespace of their own publishes theirs, with their own provider
account.

```jsonc
"dns": {
  // What records point at. Needed behind a router forwarding ports,
  // where the Gateway's own address is a private one.
  "target": "203.0.113.10",

  "providers": [
    {
      "name": "office",
      "provider": "cloudflare",
      "domains": ["example.com"],
      "excludeDomains": ["clients.example.com"],
      "namespaces": ["cc-office"],
      "credentials": { "CF_API_TOKEN": "…" }
    },
    {
      "name": "acme",
      "provider": "aws",
      "domains": ["acme.clients.example.com"],
      "namespaces": ["client-acme"],
      "credentials": { "AWS_ACCESS_KEY_ID": "…", "AWS_SECRET_ACCESS_KEY": "…" },
      "args": ["--aws-zone-type=public"]
    }
  ]
}
```

Each provider runs one ExternalDNS for each namespace it lists, in
the `external-dns` namespace. Each instance reads only its own
namespace's routes and writes only its own `domains`, so a route in
`client-acme` naming `example.com` is ignored rather than published.
`credentials` are environment variables, named as the provider's
ExternalDNS documentation names them; they go into a Secret beside
the instances, out of reach of anyone with access to the namespaces
being published. `args` passes provider settings through. `target`
can be set per provider too, and `policy` is `sync` (records go when
their route does) or `upsert-only` (nothing is ever removed).

Records are marked with an owner ID per instance, so instances sharing
a zone — or records made by hand, or another cluster's — are left
alone.

Preflight checks that no two sets of namespaces can write the same
names: a domain inside another provider's has to be in that provider's
`excludeDomains`, as `clients.example.com` is above. It also insists on
`target` when the cluster is reached through port forwarding.

The `dns` bundle installs it as part of `install`, after the charts,
and can be run again on its own after changing this section:

```bash
community-cloud run-bundle dns server-1 cc.config.json
```

A namespace publishing through ExternalDNS still needs its routes
attached to the cluster Gateway, which means the
`whereWereGoing: weDontNeedRoads` label on the namespace — see
`k8s/apps/office/Office.namespace.yaml`.

### `pipelines`

Named sequences of bundles, for `run-pipeline`:

```jsonc
"pipelines": {
  "new-node": ["base", "network", "gpu", "k3s", "nodeLabels"]
}
```

### `helm`

`version` pins the Helm release. That's all it takes.

### Checking a configuration

`preflight` reads it and says what would stop an install — no server,
two servers, a missing token, a node that can't be reached, a gateway
with no addresses — before anything is changed. That includes what the
[schema](cc.config.schema.json) rules out, such as a value of the wrong
type, or a node type, role or region that isn't one of those allowed:

```bash
community-cloud preflight cc.config.json
community-cloud preflight cc.config.json --config-only   # the file alone, no SSH
community-cloud preflight cc.config.json -n phoenix      # one node
community-cloud preflight cc.config.json --timeout 20    # wait longer for slow nodes (default 8s)
```

Without `--config-only` it goes on to connect to every node. That's
where sudo, the kernel and the network are checked, and it happens
even when the file has problems, so you see everything at once.

A key nothing reads doesn't stop anything. It gets a warning instead,
naming the key it was probably meant to be when one is close.

Once a cluster exists, its configuration is recorded in the cluster
itself as a ConfigMap in `kube-system`, with the secrets stripped.
`doctor` compares that against your file and reports anywhere they've
drifted apart.

### Asking a cluster how it is

```bash
community-cloud doctor cc.config.json                  # everything, every node
community-cloud doctor cc.config.json --verifications  # only what asserts
community-cloud doctor cc.config.json -n phoenix       # one node
community-cloud doctor cc.config.json -b lvm           # one bundle
community-cloud doctor cc.config.json --wait           # and the checks that wait
```

Some checks exist to wait for something to settle after an install,
and other checks give what they ask about a moment to catch up. On a
healthy cluster that costs nothing; when anything is wrong each one
waits out its whole timeout before saying so, which turns a report
into a long wait. So by default the waiting checks are skipped and the
others answer with what is true now. `--wait` puts both back.

Every command in every bundle says what it's for, and `doctor` runs
only the purposes that change nothing. That is what makes it safe to
point at a cluster people depend on.

It runs on the same machinery as an install, and asks every node at
once. A cluster is several machines: asking them one after another
makes the report a description of six different moments, and the first
slow node delays every answer behind it.

Two things are relaxed, because the questions are read-only. A node
that can't be reached doesn't stop the others being asked — a cluster
with a machine down is exactly the case you'd run this for — and one
failure doesn't stop the run, because one thing being broken is the
most likely reason to want to know what else is.

`preflight` goes first, even with `-b`, and a node has to pass it
before anything else is asked of it. A node that can't sudo, or can't
reach the outside world, would otherwise fail most of what follows for
that one reason, with the reason one line among fifty. Its other
bundles are reported as not asked, rather than failed. When the node
that fails is the control plane, nothing run from it is asked either,
which includes every check of what's inside the cluster.

Bundles are asked in the order an install runs them and numbered that
way, live and in the report, so the first failure is usually the lowest
broken layer and what follows it is likely its consequence.

When several checks fail with the same message — a refused Defined
Networking key fails every call to its API — the report says it once,
near the top, listing each check it took down, and counts it as one
problem. Those checks point back to it from their own places in the
report.

Under each problem is the command that would put it right, and the
commands are listed again at the end, deduplicated and in install
order, with one for `all` when every node needs the same one:

```
━━ To Put It Right ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  community-cloud run-bundle lvm guandi cc.config.json --dry-run
  community-cloud run-bundle nodeLabels guandi cc.config.json
  community-cloud run-bundle cluster cleverswing cc.config.json
```

A failed check is usually fixed by running its own bundle again, since
bundles are safe to re-run and exist to make true what their checks
look for. So that's the suggestion unless the check names other
bundles in its `remedy`, or says there's nothing to run with
`remedy: false`. A bundle that only looks (`preflight`, `node-joined`)
gets no suggestion, because running it again would find the same
thing. Neither does a failure the check explains by its status code,
such as a refused API key, because the explanation already says what
to do and no bundle can do it. A bundle marked `destructive`, such as
`lvm`, which formats free disks, is suggested with `--dry-run`, so the
first thing you type shows what it would do.

Each enabled package is first asked whether it's installed at all. One
that isn't fails that one check, which says so, and its other checks
are skipped instead of each failing in turn. The other way round,
`helm-charts` reports packages that are on the cluster without being
enabled, and `dns` reports ExternalDNS instances still running for
providers taken out of the configuration. Both are reported as
warnings, since either can be intended.

## Installing a cluster

```bash
community-cloud install cc.config.json            # every node
community-cloud install cc.config.json --dry-run  # every step, nothing run
community-cloud install cc.config.json -n node-4  # one node only
```

To add a machine to a cluster that's already running, use
[`add-node`](#adding-a-node) rather than `-n`.

These flags work the same on `install`, `add-node`, `uninstall`,
`clean`, `run-bundle` and `run-pipeline`:

| Flag | |
|---|---|
| `--dry-run` | Work out every step and print it, changing nothing. |
| `--keep-going` | Carry on past a failed step rather than stopping there. |
| `--timeout <seconds>` | How long to give a node to answer when connecting. |
| `--verbose` | Print each command's output as well as the report. Not on `install`. |

Set `CC_DEBUG` in the environment to have a failure print its stack
trace as well as its message.

Everything happens in lock step: **every node finishes a step before any
node starts the next.** Within a step the nodes work at once, so
installing K3s on six agents takes about as long as installing it on
one.

The barrier is the point. Without it a failure leaves the cluster
smeared across the install — one machine with storage and a CNI,
another three steps behind with half a package list. With it, a failure
means every node is at the same place, which is a state you can look
at, reason about, and resume from by fixing the cause and running the
install again.

### Which nodes a step runs on

Two different questions, which look like one on a single node:

| | |
|---|---|
| `runOn` | Which machine executes the shell — the node itself, or a server with kubectl. |
| `scope` | How many times, and for which nodes. |

Labelling a node shows they're separate: the shell is kubectl so it has
to run on a server, and it is nevertheless one command per node.

| Scope | Runs | For |
|---|---|---|
| `cluster` | Once | Anything addressing Kubernetes rather than a machine. The API is shared, so doing it per node would be doing it again. |
| `each-node` | Once per node | System configuration, hardware, storage. |
| `each-server` | Once per server | The K3s server install. |
| `each-agent` | Once per agent | The K3s agent install, which needs a server to join. |

A command that says nothing gets `cluster` if it runs on the control
plane and `each-node` otherwise, which is right for almost everything
already written.

### Running part of it

```bash
community-cloud run-pipeline base,network all cc.config.json
community-cloud run-pipeline lvm phoenix cc.config.json
community-cloud run-bundle nodeLabels all cc.config.json
community-cloud run-bundle k3s phoenix cc.config.json --dry-run
community-cloud run-pipeline new-node node-4 cc.config.json   # one named in "pipelines"
community-cloud list-bundles                                  # every bundle there is
community-cloud list-bundles k3s -c cc.config.json            # the commands in one
```

A pipeline is a comma-separated list of bundles, or the name of one
defined under [`pipelines`](#pipelines). `list-bundles` is where the
names come from; given a bundle, it lists that bundle's commands, which
needs the configuration for bundles whose commands are built from it.

`all` is every node in the configuration; a name is one node. A single
node is a cluster of one rather than a separate code path — the
interesting multi-node bugs are the ones that only appear with more
than one machine, and a separate path is how those hide.

`run-bundle` is `run-pipeline` with one bundle in it, and it is the
same code: the barrier between steps, the refusal to start when two
nodes turn out to be one machine, and the per-node reporting are all
there whichever you ask for.

Running a bundle against a single agent still works when something in
it needs kubectl. The agent has no kubeconfig, so the run borrows a
server from the configuration to talk to the cluster with. The borrowed
node is reachable and is not one of the nodes being worked on — no step
runs on its behalf.

The kubeconfig stays as K3s writes it, readable by root alone, since
anyone who can read it has cluster-admin. Commands that talk to the
cluster run `kubectl`, `helm` and `cilium` through `sudo -n` instead,
which is one reason the SSH user needs passwordless sudo. A cluster
installed by an earlier version of this installer has its kubeconfig
readable by every user (`644`); to tighten it, remove
`K3S_KUBECONFIG_MODE` from `/etc/systemd/system/k3s.service.env` on the
server and restart K3s.

## Adding a node

```bash
community-cloud add-node node-4 cc.config.json
community-cloud add-node node-4 cc.config.json --dry-run
```

Add the node to `nodes` in the configuration first: that file is the
record of what the cluster is, and a node added without being written
down is one that vanishes from the next install.

This is the install with the cluster-wide half taken out. Cilium, the
Gateway, Helm and the charts have already happened and would either be
re-applied for nothing or re-applied differently, because the
configuration has moved on since. What's left is everything that makes
one machine a member:

```
cluster-online → preflight → base → network → gpu
              → registries → lvm → k3s → nodeLabels → node-joined
```

`cluster-online` fails first if there is no cluster to join, which is
worth catching early — every step after it would fail in a way that
blames the new node for a problem the cluster already had.
`node-joined` is the cluster's own word that it worked: the node is
registered and its kubelet reports `Ready`, which it doesn't do until
the CNI has set the node up.

Agents only, for now. Growing the control plane means bringing the
cluster's datastore from one member to several, which isn't something
to do halfway, so `add-node` refuses a node whose type is `server`
rather than half-doing it.

### Before it connects to anything

The whole plan is worked out first, so a misspelled bundle at the end
of a pipeline fails now rather than twenty minutes in. `--dry-run`
never opens a connection at all, so it works against a cluster that
doesn't exist yet.

Two nodes that turn out to be the same machine stop the run before it
starts. That is an easy configuration mistake — a copied block with the
address changed and the port left alone, a `username` that overrides
what `~/.ssh/config` would have resolved — and without the check the
first sign of it is a cluster missing a node nobody can account for.

## Taking a node out

```bash
community-cloud uninstall node-4 cc.config.json
community-cloud uninstall node-4 cc.config.json --dry-run
community-cloud uninstall node-4 cc.config.json --skip-drain
```

This is the install read backwards, and only the part of it that
belongs to one machine:

```
cluster-online → drain → k3s-uninstall → node-removed
```

Nothing here touches Cilium, the Gateway, Helm or the charts. Those
are the cluster rather than the node, and removing them because one
machine is leaving would take the cluster down in order to shrink it.

**It keeps the data.** That is the whole distinction between this and
`clean`, and it is why the K3s install's own uninstall scripts aren't
used: `k3s-uninstall.sh` ends with `rm -rf /etc/rancher/k3s
/var/lib/rancher/k3s /var/lib/kubelet`, which on a server is the
cluster's datastore and its certificate authority. Removing the
software and removing what it was looking after are two decisions, and
running them as one means the careful version doesn't exist.

So what is left behind is:

| | |
|---|---|
| `/etc/rancher/k3s` | Configuration, registry credentials, the kubeconfig |
| `/var/lib/rancher/k3s` | The server's datastore and CA, an agent's certificates, the image cache |
| `/var/lib/kubelet` | Pod state, and the mount points node local volumes were attached at |
| every volume group | Where the data actually is — TopoLVM carves its volumes out of them |

A node uninstalled this way can be put back with `add-node` and finds
its images, its certificates and its volumes where it left them.

What *is* used from K3s's own scripts is `k3s-killall.sh`, which is
the half that changes no data: it stops the service, kills every
container and shim, and unmounts everything under `/run/k3s` and
`/var/lib/kubelet`. The unmounting matters more than it sounds, and
the clean section below says why.

### Draining first

Stopping K3s on a node kills whatever is running there. The pods come
back somewhere else a minute or two later, once the cluster notices —
which is fine for something stateless and is not fine for a database
being killed mid-write. Draining moves the work first and waits for it
to land.

Two flags are deliberately not passed to `kubectl drain`. `--force`
deletes pods belonging to no controller, and since nothing recreates
those it turns "move this workload" into "delete this workload"
without saying so. `--disable-eviction` ignores every disruption
budget in the cluster, which is the thing draining exists to respect.
So a drain that can't finish stops and says what held it up, and
`--skip-drain` is how you decide to stop the workloads instead.

`--drain-timeout <seconds>` bounds the wait, which matters because a
pod held by a disruption budget that can't be satisfied is never
evicted at all.

### Servers

```bash
community-cloud uninstall node-1 cc.config.json --server
```

A server is refused without `--server`, because uninstalling one
destroys the cluster: the datastore, the certificate authority and the
token all live on it, nothing here can put them back, and every agent
loses its control plane at once. It is the one operation in this tool
that no other command can undo.

`--server` on an agent is refused too: it agrees to destroying the
cluster, which uninstalling an agent isn't going to do, so it's more
likely a mistake about which node this is.

With the flag, the pipeline is just `k3s-uninstall`. There is nothing
to drain to — draining a control plane means evicting the pods that
would carry out the eviction — and nothing to be removed from.

Agents are taken out one at a time; `all` is refused, since draining
every node at once would mean waiting out every timeout and then
failing, having cordoned the whole cluster on the way. Take the agents
out one by one and the server last.

### When the cluster is already gone

Everything above needs a reachable control plane, to drain to and to
remove the node from. If the cluster isn't there any more, the
node-local half is a bundle like any other:

```bash
community-cloud run-bundle k3s-uninstall node-4 cc.config.json
```

## Cleaning up

```bash
community-cloud clean node-4 cc.config.json
community-cloud clean all cc.config.json
community-cloud clean node-4 cc.config.json --full          # cleans, then lists the volume groups
community-cloud clean node-4 cc.config.json --full --yes    # and destroys them
```

The other half of the decision: removing what the uninstall kept. Two
levels, because there are two sizes of loss.

By default it removes the K3s directories — the datastore, the
kubeconfig, the registry credentials, the image cache, and what is
left of the pod network. Painful, and all of it rebuildable by
installing again.

`--full` also destroys the volume groups this installer created, which
is where the data is: TopoLVM carves every persistent volume out of
them, so this is the contents of every database and every upload on
the node. Nothing here can put that back, so `--full` on its own does
the default clean — the K3s directories still go — then lists the
volume groups it would destroy and stops there:

```
cc-ssd-vg           931GB  4 logical volumes
    pvc-8f2a…         30GB
    …
Nothing was destroyed. The volume groups listed above hold what the
cluster stored on this node — run the same command again with --yes to
remove them.
```

Ownership comes from an LVM tag this installer wrote rather than from
the group's name. A group called `cc-ssd-vg` is *probably* one of
ours, and "probably" is not the standard to apply to something about
to be destroyed.

The `--yes` gate lives in the `storage-remove` bundle rather than in
the command, so that reaching it another way — `run-bundle`, a
pipeline in the configuration — is no shorter a path. `--keep-going`
doesn't get past it either: the step that does the removing checks for
approval as well as the step that asks for it, because a run told to
carry on past failures would otherwise note the refusal and walk
straight past it.

### Why it won't clean a running node

Cleaning refuses while K3s is running, and refuses while anything is
still mounted under `/var/lib/kubelet`, `/var/lib/rancher` or
`/run/k3s`. The second is
the one worth the trouble: `rm -rf /var/lib/kubelet` with a volume
still mounted underneath descends through the mount point and deletes
what is *in* the volume, which is exactly the data every other
decision here is arranged to protect. An uninstall unmounts those, so
the usual answer is to run one first.

### What is left alone

Cilium's datapath is removed by `clean` and reported by
`k3s-uninstall` rather than removed — the `cilium_*` interfaces, the
veth pairs and the eBPF programs attached to them belong to Cilium
rather than to K3s, and a node that is going back into a cluster may
well want them. A reboot clears them either way.

A node's mesh membership — Nebula or Tailscale — is left alone by
both. It is usually how you are reaching the machine.

## Tests

```bash
bun run test           # everything
bun run test:watch     # on change
bun test src/test/plugins.test.ts
```

They live in `src/test`, use the `node:test` API with `node:assert`,
and reach nothing outside the repository — no live node, no cluster, no
`cc.config.json`. The configuration they work against is the fixture in
`src/test/fixtures`, which sets every value the manifests reference and
holds no real credentials.

Nothing under `src/test` reaches a shipped binary: the build compiles
from `src/cli/installer.ts` and the bundler only follows imports, so a
file nothing imports is never seen.

**On the runner.** The tests are written against Node's own test API,
and `node --test` cannot currently run them:

- the codebase uses `enum` in nine modules, and Node's type stripping
  refuses non-erasable syntax — `--experimental-transform-types` used
  to handle it and is gone as of Node 26
- `src/util/embedded.ts` needs `bun:sqlite` to read the manifests
  compiled into the binary

So `bun test` is the runner, and it implements `node:test` faithfully.
Writing against the standard API rather than `bun:test` costs nothing
today and means the tests move if the runtime ever does.

### Scripts that need a real node

`src/test/manual` holds two that talk to a live machine, so they are
run by hand rather than by `bun test`:

```bash
bun src/test/manual/cliInstall.ts cc.config.json phoenix
bun src/test/manual/K3sInstall.ts cc.config.json phoenix
```

## Building

The installer ships as a single executable. It needs nothing on the
machine it runs on: no Bun, no Node, and no checkout of this
repository, because the manifests and values files under `k8s/` are
embedded in the binary.

```bash
cd installer
bun install
bun run build            # every platform
bun run build linux      # or a filter: linux, macos, windows, arm64, musl
bun run build linux-x64  # or one target by its exact name
```

Executables land in `installer/build/`:

| Target | File |
| --- | --- |
| Linux x64 (glibc) | `community-cloud-linux-x64` |
| Linux arm64 (glibc) | `community-cloud-linux-arm64` |
| Linux x64 (musl/Alpine) | `community-cloud-linux-x64-musl` |
| Linux arm64 (musl/Alpine) | `community-cloud-linux-arm64-musl` |
| macOS Apple silicon | `community-cloud-macos-arm64` |
| macOS Intel | `community-cloud-macos-x64` |
| Windows x64 | `community-cloud-windows-x64.exe` |
| Windows arm64 | `community-cloud-windows-arm64.exe` |

Every target cross-compiles from whatever machine you build on, so a
release can be cut from a laptop.

### Releases

`.github/workflows/installer.yml` builds every target on each pull
request and push to `main`, after the tests. It then runs each
executable on its own operating system: `--version`, the embedded
manifests and Headlamp plugins, and a template rendered with
`--dry-run`. The executables are kept as workflow artifacts for a week.

Pushing a tag `installer-v<version>` does the same and then publishes a
GitHub release with every executable and a `SHA256SUMS` file. The
release script pushes it, from the repository's root:

```bash
bun scripts/release/installer.ts set 0.2.0   # package.json's version; commit and merge it
bun scripts/release/installer.ts --dry-run   # the checks alone
bun scripts/release/installer.ts             # the checks, then the tag, pushed
```

It tags only what's on `origin/main`, with nothing uncommitted, and
only a version newer than the last one released. The installer carries
manifests that pin images of ours, so it also refuses while one of
them names a release that isn't out yet: after Cirrus's version is set,
release Cirrus before the installer.

The tag's version is what the executables report with `--version`.
Builds that aren't releases report `package.json`'s version with the
commit on it, e.g. `0.1.0-dev.dcf704b`. A version with a hyphen in it,
like `0.2.0-rc.1`, is published as a pre-release.

### Embedded manifests

The manifests and values files under `k8s/` are compiled into the
binary as a SQLite database, so a released executable can apply them on
a machine that has never seen this repository.

They're referred to with an `embed://` URL, and the paths have no
`k8s/` prefix:

```bash
community-cloud run-template embed://ai/vLLM/vllm-amd.yaml cc.config.json --dry-run
community-cloud run-template embed://ai/vLLM/vllm-amd.yaml cc.config.json
community-cloud run-template ./ops/my-template.yaml cc.config.json -o delete
community-cloud list-embedded              # everything it carries
community-cloud list-embedded authentik    # filtered
```

**`run-template` applies what it renders** with `kubectl apply`, using
whatever kubeconfig this machine has, unless it's given `--dry-run`,
which prints the rendered manifest and stops. `-o delete` deletes
instead, `-n <node>` runs kubectl on that node over SSH, and
`--namespace` scopes the operation and says which namespace's
`.Values.mail` to render.

`bun run build` rebuilds `src/generated/embedded.sqlite` before
compiling, so anything added under `k8s/` is picked up automatically.
Rebuild it on its own with:

```bash
bun run build:embedded
```

The Headlamp plugins in `headlamp/plugins/` go into the same database,
built: each one's `dist/main.js` and `package.json`, stored as
`headlamp-plugins/<name>/`. Neither `build` nor `build:embedded` builds
them, and a plugin with no build is left out with only a warning, so
after changing one, build it first:

```bash
bun run build:plugins     # npm ci where needed, then npm run build, in each plugin
bun run build:embedded
```

The database has one table, `files`, with `path` and `contents`
columns and a unique index on `path`. It's built from scratch each
time and the rows go in sorted, so the same tree always produces the
same bytes and a rebuild only shows up in a diff when something under
`k8s/` actually changed.

From `k8s/`, only `.yaml` and `.yml` files are embedded — the READMEs
there are for people reading the repository, and nothing reads them at
runtime.

### Other scripts

```bash
bun run cc <args>        # run from source without building
bun run typecheck        # tsc --noEmit
bun run build:linux      # one platform's executables (also :macos, :windows)
bun run build:plugins    # the Headlamp plugins, for build:embedded
```

## Writing commands

A command is a string, an array of strings, or a function returning
either. Nearly all of them are several lines of shell, so the array
form is the usual one and the lines are joined for you:

```ts
{
  name: "wait-for-service",
  description: "Wait for the service to come up",
  command: [
    `for attempt in $(seq 60); do systemctl is-active --quiet ${SERVICE} && break; sleep 1; done`,
    `systemctl is-active --quiet ${SERVICE} || { echo "${SERVICE} never came up" >&2; exit 1; }`,
  ],
}
```

The lines are joined with a newline rather than `"; "`, which is what
the shell words taking a body straight after them require — `for x in
y; do; echo $x; done` is a syntax error, and an easy one to write when
a join is putting the separators in.

## Secrets in commands

Anything a command is given on its command line is readable by every
user on that node through a process listing, and gets quoted back in
error messages and logs besides. Credentials go over standard input
instead, which only the process reading it ever sees.

A command spec has two ways to do that:

```ts
{
  name: "write-config",
  description: "Write a config file that holds a password",
  command: [
    `sudo install -o root -g root -m 0600 /dev/null ${FILE}`,
    `sudo tee ${FILE} > /dev/null`,
  ],
  // A payload for the command to read
  stdin: (config) => buildFile(config),
}
```

```ts
{
  name: "install-something",
  description: "Run an installer that reads a token from its environment",
  env: { INSTALL_VERSION: "1.2.3" },
  // Read and exported by a preamble on the far side, so the value
  // never appears in an argument list
  secretEnv: (config) => ({ TOKEN: config.getToken() }),
  command: "sh ./install.sh",
}
```

Both accept a plain value or a function taking the same arguments a
command builder does. A few rules follow from a command having only
one standard input:

- `stdin` and `secretEnv` can't both be set on one command
- `secretEnv` values have to be single lines; a document belongs on
  `stdin`
- `secretEnv` can't be combined with `sudo`, which clears the
  environment it was given — the only way to put a value back is to
  name it in sudo's own arguments, which is the command line these are
  meant to stay off

Where a tool only accepts a secret as a flag, read it into a shell
variable and hand it over from there:

```ts
command: [
  "code=$(cat)",
  '[ -n "$code" ] || { echo "nothing on standard input" >&2; exit 1; }',
  'sudo dnclient enroll -code "$code"',
],
stdin: (config, context) => context.enrollmentCode,
```

That keeps the value out of the command this installer builds and out
of what SSH carries, though it still reaches the tool's own arguments
while it runs.

## Generated credentials

Some of what the cluster needs is a password that nothing outside the
cluster has any reason to know. The database roles under
`k8s/apps/office/Office.roles.yaml` are the case that drives this:
each reads its password from a Secret, and the Secret can't be checked
into the repository next to the manifest that names it.

So the installer invents them. A package declares what it needs and
the credentials are created between its chart and the manifests that
refer to them:

```ts
{
  name: "cloudnative-pg",
  // ...
  secrets: [
    {
      name: "twenty-crm",
      description: "the Twenty CRM database role",
      namespace: "cc-office",
      username: "twenty_crm",
      labels: { "cnpg.io/reload": "true" },
    },
  ],
}
```

By default each becomes a `kubernetes.io/basic-auth` Secret with a
three-word username and a five-word password, hyphen separated, drawn
from a word list seeded out of `node:crypto` — five words is about
fifty-five bits, and a phrase survives being read down a telephone in a
way a string of punctuation doesn't. `username` is only needed where
something downstream insists on a particular one; left out, it's
generated too. CloudNativePG is why it's set on every database role,
those in `Office.roles.yaml` and the ones Lago, Documenso and Plane
bring: a
role's Secret has to carry the role's own Postgres name, underscores
and all, and the role is refused outright if it doesn't.

Not everything a package needs is a login, so a definition can ask for
something else instead (see `SecretDefinition` in
`src/cli/commands/Secrets.ts`):

| Field | Makes |
|---|---|
| `keyBytes` | A random key of that many bytes, in hex, for the encryption keys that refuse a phrase for being the wrong length. |
| `certificate` | A self-signed certificate, as a PKCS#12 bundle and the passphrase sealing it — Documenso signs documents with one. |
| `privateKey` | An RSA private key in PEM — Lago signs its sessions with one. |
| `connectionString` | A URL for cc-postgres built from a role's credentials, for something that wants one string — Mattermost's operator. |

`type` sets a different Secret type, and `labels` adds labels some
operators find their Secrets by.

**A password is created once and never rewritten.** The command looks
first and does nothing if the Secret is there, so running an install
again doesn't rotate the credentials half the cluster is already using.
Nothing records what was generated, either — it exists in the cluster
and nowhere else:

```bash
kubectl -n cc-office get secret twenty-crm \
  -o jsonpath='{.data.password}' | base64 -d
```

To rotate one deliberately, change it in the Secret — or delete the
Secret and install again for a fresh one. The role's password follows
within a few seconds, so anything holding a live connection will need
restarting.

That last part is what the `cnpg.io/reload` label above buys. The part
of CloudNativePG that talks to Postgres can't read Secrets on purpose,
since the permission to read one is the permission to read all of them
in the namespace; the operator watches them instead and pokes the role
when one changes. It only watches Secrets carrying that label. Without
it the first password is applied — the role is retried until its Secret
appears — and no later one ever is.

## Contributing

Contributions are welcome. The one thing worth knowing before writing a command: see [Writing commands](#writing-commands) and [Secrets in commands](#secrets-in-commands) above.

## License

The installer is licensed under the **GNU Lesser General Public
License, version 3 or later** (LGPL-3.0-or-later). See
[LICENSE.md](./LICENSE.md), with the licence texts themselves in
[COPYING.LESSER](./COPYING.LESSER) and [COPYING](./COPYING).

The rest of the repository is [MIT](../LICENSE.md).
