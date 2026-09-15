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
community-cloud run-bundle k3s server-1 cc.config.json
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
| `disable` | — | Packaged components to leave out, e.g. `metrics-server`. `traefik` and `servicelb` are *always* left out whatever this says — Cilium's Envoy serves the Gateway API and Cilium's own IP management hands out load balancer addresses. |
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

### `packages`

Which Helm charts to install. `true` is shorthand for enabled.

```jsonc
"packages": {
  "cert-manager": true,
  "cloudnative-pg": true,
  "authentik": { "enabled": true, "version": "2024.10.1" }
}
```

In the catalogue: `cert-manager`, `cloudnative-pg`, `authentik`,
`topolvm`, `headlamp`, `tailscale-operator`. Dependencies are worked
out and installed first — Authentik needs CloudNativePG, so enabling
it enables that too.

A package not in the catalogue needs `repo` and `chart`. Any package
takes `version`, `namespace`, `releaseName`, `valuesFile` (relative to
the working directory) and `requires`.

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

## Contributing

Contributions are welcome. The one thing worth knowing before writing a command: see [Writing commands](#writing-commands) and [Secrets in commands](#secrets-in-commands) above.

## License

This project is licensed under the [MIT License](../LICENSE.md).
