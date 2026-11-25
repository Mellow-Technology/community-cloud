![Community Cloud](https://community-cloud.technology/cloud-logo-color.png)

# Community Cloud

A multi-node, multi-site Kubernetes platform built on K3s, designed to provision and manage distributed infrastructure with automated storage, networking, and application lifecycle management.

Community Cloud is currently in Alpha but is usable. We're currently undergoing heavy active development. See our Roadmap [here](https://github.com/orgs/Mellow-Technology/projects/1).

### Github

While currently on Github we're actively expecting to migrate away at the earliest convenient time. More soon!

## Using AI

AI is the hot topic right now in anything technology related, and naturally Community Cloud is no different. Our policy towards using AI is simple, it's completely fine to use. That being said, if you would like to contribute please keep the following in mind: 

1. _You_ are responsible for your contribution and ensuring its quality
2. You fully understand what you're contributing. If you can't explain it to someone with reasonable knowledge of what you're trying to do then it won't be accepted.
3. AI can write your code, but it should never speak on your behalf. Write your PRs, and make sure corresponding documentation is accurate.
4. Try not to waste our time and your time 🕰️


## Architecture Overview

Community Cloud deploys a K3s cluster across heterogeneous hardware, organizing nodes into functional roles:

| Role | Purpose |
|---|---|
| `gateway` | Publicly routable nodes serving as cluster ingress/egress, via the Gateway API on Cilium's Envoy |
| `lighthouse` | Nebula lighthouses, which nodes on other networks find each other through |
| `worker` | General-purpose workload nodes |
| `worker-gpu` | GPU-equipped nodes for AI/ML inference (AMD, NVIDIA, Intel) |
| `storage-local` | Nodes with local block devices for TopoLVM CSI provisioning |
| `storage-distributed`, `storage` | Nodes participating in distributed storage pools |

### Storage Architecture

Two complementary storage layers:

| Layer | Technology | Use Case |
|---|---|---|
| **Local SSD** | TopoLVM (LVM-based CSI driver) | Fast, node-local storage — default StorageClass `cc-local-ssd-fast` |
| **Object** | SeaweedFS (S3-compatible), on local SSD | A bucket per application, for uploads and files |

TopoLVM supports four device classes mapped to LVM volume groups:

| Device Class | Volume Group | Medium |
|---|---|---|
| `ssd` | `cc-ssd-vg` | M.2 NVMe (fastest) |
| `ssd-sata` | `cc-ssd-sata-vg` | SATA SSD |
| `ssd-cache` | `cc-ssd-cache-vg` | SSD cache fronting spinning disks (reserved — see [storage](./k8s/storage/README.md#on-ssd-cache)) |
| `hdd` | `cc-hdd-vg` | Spinning disk (capacity) |

Object storage is provided by [SeaweedFS](https://github.com/seaweedfs/seaweedfs) (S3-compatible), run by its operator on local SSD. Each application gets a bucket of its own, and keys to only that bucket. Applications reach it inside the cluster, and it's also on its own hostname for the signed links browsers follow. How much disk it and the database claim is set under `storage.allocations` in the installer configuration.

### Networking

- **CNI**: Cilium, with its eBPF datapath replacing kube-proxy
- **Gateway**: the Kubernetes Gateway API, served by Cilium's own Envoy. K3s is installed with `--disable=traefik --disable=servicelb`, since Cilium replaces both
- **Load balancer addresses**: Cilium IP address management, with L2 announcements on networks where a router forwards to an address nothing holds
- **Certificates**: cert-manager with Let's Encrypt (HTTP-01 challenges via Gateway API)
- **Cross-Site**: a Nebula mesh through Defined Networking, for nodes that can't reach each other directly
- **Tailscale**: optionally, the Tailscale operator exposes cluster services on a tailnet
- **Ingress**: dedicated gateway nodes, selected by the `gateway` role

### Database Services

| Service | Technology | Details |
|---|---|---|
| PostgreSQL + PostGIS | CloudNative-PG | `cc-postgres`, single-instance, 30Gi SSD by default, PostGIS 3.6 extension |
| Redis | Opstree Operator | Standalone, 5Gi SSD |
| RabbitMQ | RabbitMQ Cluster Operator | `rabbitmq`, single node, 5Gi SSD |
| MariaDB | MariaDB Operator | `cc-mariadb`, single-instance, 10Gi SSD by default, for the applications that only run on MySQL |
| PostgreSQL, per namespace | CloudNative-PG | `cirrus-postgres`, made by Cirrus in a namespace the first time one of its WebApplications asks for a database |

## Project Structure

```
community-cloud/
├── installer/          # CLI tool for cluster provisioning (LGPL)
│   ├── src/
│   │   ├── cli/        # Commander entry point, Inquirer configuration editor
│   │   │   ├── commands/ # Every step: K3s, LVM, Cilium, packages, secrets, mail, DNS…
│   │   │   └── configure/ # The sections of the configuration editor
│   │   ├── pipeline/   # Running bundles across the fleet in lock step
│   │   ├── topology/   # Regions and sites
│   │   ├── runners/    # One per CLI command
│   │   ├── plugins/    # Loading and approving plugins
│   │   ├── remote/     # SSH/remote host abstraction
│   │   ├── generated/  # The manifests and plugins compiled into the binary
│   │   ├── test/
│   │   └── util/       # Configuration, templates, credentials, helpers
│   ├── scripts/        # Build, embedding, Headlamp plugin builds
│   ├── cc.config.schema.json
│   └── package.json
├── k8s/                # Kubernetes manifests & Helm values
│   ├── ai/             # The NVIDIA and AMD device plugins' values; local models behind llama-swap (AMD Ryzen AI Max), applied by hand
│   ├── apps/           # Application deployments (Twenty CRM, Lago, Documenso, Mattermost, Plane, Methods, Headlamp, Meteorologist, etc.)
│   ├── certs/          # cert-manager values and the cluster's Let's Encrypt issuer
│   ├── crd/            # The Site CRD draft, not yet applied by anything
│   ├── database/       # PostGIS
│   ├── k3s-config/     # Placeholder: K3s's node configuration is generated by the installer
│   ├── monitoring/     # Prometheus, Alertmanager and Grafana: values, monitors, rules, dashboards
│   ├── mq/             # The RabbitMQ operators, and a placeholder for NATS
│   ├── networking/     # Cilium, the cluster Gateway, Tailscale
│   ├── operators/      # Community Cloud's own operators, as installed: Cirrus
│   ├── storage/        # TopoLVM, SeaweedFS, StorageClasses
│   └── values.example.yaml
├── operators/          # Community Cloud's own operators
│   └── cirrus/         # Cirrus (Rust): runs WebApplications, rolls out GitLab pipelines, publishes DNS
├── ui/                 # Community Cloud's own interfaces
│   └── meteorologist/  # Meteorologist (Next.js): applications and namespaces, as whoever signed in
├── headlamp/           # Community Cloud's Headlamp plugins (LGPL)
│   └── plugins/        # cc-cumulus-theme, cc-storage-explorer
├── scripts/release/    # Tagging releases of the installer, Cirrus and Meteorologist
├── .github/workflows/  # Builds and images for the installer, Cirrus and Meteorologist
├── docs/               # Documentation
├── Vagrantfile
├── LICENSE.md
└── README.md
```

### Top-Level Files

| File | Purpose |
|---|---|
| `cc.config.json` | The cluster's configuration — nodes, networking, storage, packages, registries. Gitignored, since it holds secrets. See the [installer README](./installer/README.md#configuration) |
| `Vagrantfile` | Local dev environment — 3 Ubuntu 24.04 VMs with 3x 25GB disks each |
| `.gitignore` | Ignored files — `*.config.json` among them |
| `LICENSE.md` | License information. MIT, except `installer/` and `headlamp/`, which are LGPL-3.0-or-later |
| `headlamp/plugins/` | Community Cloud's own Headlamp plugins |
| `docs/index.md` | Documentation index |

## Installer

The installer (`installer/`) is a Bun-based CLI that automates multi-node K3s cluster deployment:

- **Configuration**: `community-cloud` with no arguments builds or edits a configuration interactively (Inquirer), checked against a JSON Schema
- **Checks**: `preflight` before an install, and a read-only `doctor` for a running cluster
- **Remote Execution**: SSH-based remote command execution with key/password/agent auth fallback, every node in lock step
- **Node Roles**: Automatic labeling and role assignment (`gateway`, `worker`, `storage-local`, etc.)
- **Storage Setup**: LVM2 physical/logical volume creation, TopoLVM CSI driver installation
- **K3s Provisioning**: Server/agent bootstrap, Gateway API CRD installation, cert-manager deployment
- **Registry Auth**: K3s private registry configuration
- **GPU Detection**: Automatic AMD/NVIDIA/Intel GPU identification
- **NVIDIA**: the container toolkit on nodes with an NVIDIA card, and the device plugin on those whose driver works, so pods can ask for `nvidia.com/gpu`
- **AMD**: the device plugin on nodes whose `amdgpu` driver works, so pods can ask for `amd.com/gpu`, with nothing to install on the node
- **Packages**: Helm charts and applications, installed in dependency order with their database roles, buckets and credentials generated
- **Sign-in**: applications sign in through Authentik, over OpenID Connect or behind an oauth2-proxy gate; Headlamp signs people into the cluster itself
- **Mail and DNS**: per-namespace SMTP credentials, and hostnames published through ExternalDNS
- **Plugins**: further packages and bundles from approved plugin archives — see [docs/plugins.md](./docs/plugins.md)
- **Adding nodes**: `add-node` joins a machine to a running cluster
- **Teardown**: `uninstall` drains a node and removes K3s while keeping its configuration, images and volume groups; `clean` removes those separately, and only destroys the disks when told to twice

### Building the Installer

```bash
cd installer

bun run build              # every platform, into build/
bun run build:linux        # → community-cloud-linux-{x64,arm64}, and -musl builds of each
bun run build:macos        # → community-cloud-macos-{arm64,x64}
bun run build:windows      # → community-cloud-windows-{x64,arm64}.exe
bun run cc <args>          # run from source without building
```

See the [installer README](./installer/README.md#building) for the
embedded manifests and Headlamp plugins a build carries.

## Kubernetes Manifests

### Custom Resource Definitions

| CRD | Scope | Purpose |
|---|---|---|
| `WebApplication` (`webapp`) | Namespace | An application and what it needs — Deployment, Service, database, bucket, vhost, Gateway routes, migrations — rolled out from GitLab pipelines |
| `DnsProvider` | Cluster | A DNS provider account, the domains it holds, and the namespaces whose hostnames it publishes, through an ExternalDNS for each |

Both are run by Cirrus, the operator in `operators/cirrus`, which the
`cirrus` package installs. Meteorologist, in `ui/meteorologist`, is
the web interface for them. `k8s/crd/sites.crd.yaml` is meant
to become a cluster-scoped `Site`, but is still a copy of the old
Webapp draft.

### Applications

| App | Namespace | Status |
|---|---|---|
| Authentik | `cc-office` | `authentik` package — single sign on, for the applications and the cluster, on cc-postgres and a SeaweedFS bucket |
| Twenty CRM | `cc-office` | `twenty` package — server and worker, on cc-postgres, Redis and a SeaweedFS bucket |
| Lago | `cc-office` | `lago` package — billing, on cc-postgres, Redis and a SeaweedFS bucket |
| Plane | `cc-office` | `plane` package — projects, on cc-postgres, Redis, RabbitMQ and a SeaweedFS bucket |
| Methods | `cc-office` | `methods` package — projects, for people and bots, on cc-postgres and a SeaweedFS bucket, through Authentik |
| Documenso | `cc-office` | `documenso` package — document signing, through Authentik |
| ProjectSend | `cc-office` | `projectsend` package — file sharing with clients, through Authentik, on cc-mariadb, Redis and a volume or SeaweedFS bucket |
| Mattermost | `cc-office` | `mattermost` package — chat, through its operator, on cc-postgres and a SeaweedFS bucket |
| Headlamp | `community-cloud` | `headlamp` package — cluster UI, signed into through Authentik, with our plugins |
| Meteorologist | `community-cloud` | `meteorologist` package — Community Cloud's web interface for applications and namespaces, signed into through Authentik, acting as whoever signed in |
| Prometheus and Grafana | `community-cloud` | `monitoring` package — metrics and alerts, with Grafana signed into through Authentik |
| Picoclaw | `cc-office` | `picoclaw` package — AI agent, behind an Authentik gate |

Authentik, Twenty, Plane, Methods, ProjectSend, monitoring and
Meteorologist run on our own cluster, along with Cirrus. The rest
haven't run on real hardware in their current form yet.

### AI Inference

- **NVIDIA**: the `nvidia` bundle installs NVIDIA's container runtime, which K3s offers as the `nvidia` RuntimeClass, and the device plugin (`k8s/ai/NvidiaDevicePlugin`) on nodes whose driver works. It doesn't install the driver itself.
- **AMD**: the `amd` bundle installs AMD's device plugin (`k8s/ai/AmdDevicePlugin`) on nodes whose `amdgpu` driver works. The kernel's own driver is enough; ROCm comes in the workload's image. Cards aren't shared.
- **Local models** on an AMD Ryzen AI Max (gfx1151) (`k8s/ai/Models/`): llama-swap in `cc-ai`, one OpenAI-compatible endpoint in front of llama.cpp (Vulkan) servers it starts and stops as models are asked for, all on the one card. The model list is a ConfigMap. Offered to `cc-office` as the `models` ServiceOffering. No package installs it; apply it by hand.

## Quick Start

1. **Build a configuration** with `community-cloud`, describing your nodes
2. **Enable the applications** you want under `packages`; the install brings in what they need
3. **Check it** with `community-cloud preflight cc.config.json`
4. **Install** with `community-cloud install cc.config.json` — every node is prepared, K3s installed, Cilium and the cluster Gateway set up, and then every package in dependency order

## Tech Stack

- **Runtime**: Bun (installer), K3s (Kubernetes)
- **Languages**: TypeScript, Rust (Cirrus), YAML
- **CLI Framework**: Commander.js, Inquirer, node-ssh
- **Operator**: kube-rs (Cirrus)
- **Web interface**: Next.js and React (Meteorologist)
- **Storage**: TopoLVM, SeaweedFS
- **Networking**: Cilium (CNI, Gateway API, load balancer IPAM), cert-manager, Nebula, Tailscale
- **Databases and queues**: CloudNative-PG (PostgreSQL/PostGIS), MariaDB (its operator), Redis (Opstree), RabbitMQ (its Cluster Operator)
- **Monitoring**: Prometheus, Alertmanager and Grafana (kube-prometheus-stack)
- **AI**: llama-swap and llama.cpp (AMD GPU), the NVIDIA Container Toolkit and device plugin, AMD's device plugin
