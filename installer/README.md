# Community Cloud Installer

The Community Cloud Installer is a command-line interface (CLI) tool designed to simplify the deployment and configuration of K3s clusters across multiple nodes and sites. Whether you're setting up a single-site environment or managing a distributed multi-site infrastructure, this installer provides an automated, reliable way to get your cluster up and running.

## Key Features

- **Multi-Node, Multi-Site Deployment**: Seamlessly configure K3s across multiple nodes and sites with minimal manual intervention.
- **Automatic Storage Configuration**: The installer automatically sets up and configures storage solutions using [TopoLVM](https://github.com/topolvm/topolvm), providing dynamic volume provisioning and snapshot capabilities tailored to your cluster's needs.
- **Database Support**: Built-in support for PostgreSQL and MySQL databases via MariaDB, enabling easy deployment of database services within your cluster.
- **Tailscale Integration**: Enable secure cross-site communication with automatic Tailscale configuration, allowing nodes in different networks to communicate as if they were on the same local network.
- **Zero-Trust Networking**: Leverage Tailscale's built-in security features to maintain a secure and isolated cluster environment without additional configuration.
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
```

**The file holds secrets** — the cluster token, registry passwords, a
Nebula API key — so it's gitignored here as `*.config.json`. What the
installer records *in* the cluster has those stripped out; see
[Secrets in commands](#secrets-in-commands).

### A small complete example

```jsonc
{
  "config": { "adminEmail": "you@example.com" },

  "k3s": { "token": "a-long-shared-secret" },

  "values": {
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
| `address` | How to reach it over SSH. Often an alias from `~/.ssh/config` rather than a name DNS knows. |
| `type` | `server` or `agent`. Exactly one node should be a `server`. |
| `username` | The SSH user. Needs passwordless sudo. |
| `keyFile` | A private key path. Otherwise the usual `~/.ssh` keys and your agent are tried. |
| `port` | SSH port, when it isn't 22. |
| `apiAddress` | Where *other nodes* reach this one's Kubernetes API, when that differs from `address`. A bastion or port forward gets you to a node without being a name the cluster can use. |
| `nodeName` | What to register as in the cluster, when `name` and `address` can't be DNS labels. `"Mamoru BKK"` and `10.0.0.5` both can't. |
| `gateway` | `true` if the outside world can reach this node. See `network.gateway`. |
| `roles` | What it's for: `worker`, `worker-gpu`, `storage-local`, `storage-distributed`, `storage`, `gateway`, `lighthouse`. Applied as `node-role.kubernetes.io/<role>` labels, which is what the manifests in `k8s/` select on. |
| `labels` | Anything else worth labelling it with, as key/value pairs. |
| `region`, `zone` | Where it physically is. Kubernetes spreads workloads across zones. Region codes are fixed — see `src/topology/regions.ts`. |
| `storage` | Per-node storage settings, overriding the cluster-wide `storage` section. |
| `nebula` | Per-node mesh settings: `role`, `listenPort`, `staticAddresses`, `isLighthouse`, `isRelay`. |

Some roles are worked out rather than written down: a node with a GPU
gets `worker-gpu`, and one with `"gateway": true` gets `gateway`.

### `k3s`

| Key | Default | Meaning |
|---|---|---|
| `token` | — | The cluster token. The server and every agent need the same one. Required. |
| `version` / `channel` | current stable | Pin the K3s release. |
| `clusterCidr` | `10.42.0.0/16` | The pod network. Wants to agree with the Cilium values. |
| `disable` | — | Packaged components to leave out, e.g. `metrics-server`. `traefik`, `servicelb` and `local-storage` are *always* left out whatever this says — Cilium's Envoy serves the Gateway API, Cilium's own IP management hands out load balancer addresses, and TopoLVM provisions local volumes. K3s's local-path provisioner also claims to be the default storage class, and Kubernetes allows only one. |
| `extraServerArgs`, `extraAgentArgs` | — | Anything else to pass through. |
| `kubeconfig` | `/etc/rancher/k3s/k3s.yaml` | Where kubectl should look, for a cluster this didn't build. |

### `network`

Kernel networking settings sit at the top of this section; everything
else is a subsection.

| Key | Default | Meaning |
|---|---|---|
| `congestionControl` | `bbr` | TCP congestion control. BBR holds throughput up over links that lose the odd packet, which CUBIC reads as congestion. |
| `qdisc` | `fq` | The default queueing discipline. BBR wants a fair-queueing one underneath it. |
| `congestionModule` | `tcp_<algorithm>` | The kernel module, when it isn't named after the algorithm. |

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

### `storage`

Which disks TopoLVM may carve volumes out of. Can also be set per
node, which is usually where it belongs — nodes differ in their disks
more than in anything else.

| Key | Meaning |
|---|---|
| `disks` | Consider only these, by path. This **narrows** what's considered; it never overrides a safety check. |
| `diskClasses` | Put a disk in a class other than the one its hardware suggests: `{"/dev/sdb": "hdd"}`. |
| `minimumSizeGb` | Ignore disks smaller than this. Defaults to 1. |

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

### `packages`

Which Helm charts to install. `true` is shorthand for enabled.

```jsonc
"packages": {
  "cert-manager": true,
  "cloudnative-pg": true,
  "topolvm": { "enabled": true, "version": "15.5.2" }
}
```

In the catalogue: `cert-manager`, `cloudnative-pg`, `topolvm`,
`headlamp`, `tailscale-operator`. Dependencies are worked out and
installed first — TopoLVM needs cert-manager, so enabling it enables
that too.

A package not in the catalogue needs `repo` and `chart`. Any package
takes `version`, `namespace`, `releaseName`, `valuesFile` (relative to
the working directory) and `requires`.

Applications live in plugins rather than in the catalogue. Authentik is
the worked example — see [`plugins`](#plugins) below.

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
  "authentik": {
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
Authentik's package is `authentik`, not `authentik:authentik`.

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

### `values` and `config`

What the manifests under `k8s/` render against. Anything in `values`
is available as `.Values.<path>`; the top level of the configuration
is too, so `config.adminEmail` reaches a manifest as
`.Values.adminEmail`.

The manifests currently reference `adminEmail`, `domain.main`,
`domain.auth`, `domain.agent`, `domain.crm`, `domain.mattermost` and
`authentik.secretKey`. A few values are derived rather than written:
`k8sApiServer` and `k8sApiPort` come from the control-plane node,
`l2Announcements` from the gateway mode, and `networkDevices` from the
shared interface list.

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
with no addresses — before anything is changed:

```bash
community-cloud preflight cc.config.json
```

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
```

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

## Installing a cluster

```bash
community-cloud install cc.config.json            # every node
community-cloud install cc.config.json --dry-run  # every step, nothing run
community-cloud install cc.config.json -n node-4  # one node, to add a machine
```

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
```

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

### Embedded manifests

The manifests and values files under `k8s/` are compiled into the
binary as a SQLite database, so a released executable can apply them on
a machine that has never seen this repository.

They're referred to with an `embed://` URL, and the paths have no
`k8s/` prefix:

```bash
community-cloud run-template embed://ai/vLLM/vllm-amd.yaml cc.config.json
community-cloud run-template ./ops/my-template.yaml cc.config.json
community-cloud list-embedded              # everything it carries
community-cloud list-embedded authentik    # filtered
```

`bun run build` rebuilds `src/generated/embedded.sqlite` before
compiling, so anything added under `k8s/` is picked up automatically.
Rebuild it on its own with:

```bash
bun run build:embedded
```

The database has one table, `files`, with `path` and `contents`
columns and a unique index on `path`. It's built from scratch each
time and the rows go in sorted, so the same tree always produces the
same bytes and a rebuild only shows up in a diff when something under
`k8s/` actually changed.

Only `.yaml` and `.yml` files are embedded — the READMEs under `k8s/`
are for people reading the repository, and nothing reads them at
runtime.

### Other scripts

```bash
bun run cc <args>        # run from source without building
bun run typecheck        # tsc --noEmit
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

Each becomes a `kubernetes.io/basic-auth` Secret with a three-word
username and a five-word password, hyphen separated, drawn from a word
list seeded out of `node:crypto` — five words is about fifty-five bits,
and a phrase survives being read down a telephone in a way a string of
punctuation doesn't. `username` is only needed where something
downstream insists on a particular one; left out, it's generated too.
CloudNativePG is why it's set on all three database roles: a
`DatabaseRole`'s Secret has to carry the role's own Postgres name,
underscores and all, and the role is refused outright if it doesn't.

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
