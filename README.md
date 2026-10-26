![Community Cloud](https://community-cloud.technology/cloud-logo-color.png)

# Community Cloud

A multi-node, multi-site Kubernetes platform built on K3s, designed to provision and manage distributed infrastructure with automated storage, networking, and application lifecycle management.

Community Cloud is currently in Alpha but is usable. We're currently going undergoing heavy active development. See our Roadmap [here](https://github.com/orgs/Mellow-Technology/projects/1).

### Github

While currently on Github we're actively expecting to migrate away at the earliest convenient time. More soon!

## Using AI

AI is the hot topic right now in anything technology related, and naturally Community Cloud is no different. Our policy towards using AI is simple, it's completely fine to use. That being said, if you would like to contribute please keep the following in mind: 

1. _You_ are responsible for your contribution and ensuring its quality
2. You fullly understand what you're contributing. If you can't explain it to someone with reasonable knowledge of what you're trying to do then it won't be accepted.
3. AI can write your code, but it should never speak on your behalf. Write your PRs, and make sure corresponding documentation is accurate.
4. Try not to waste our time and your time 🕰️


## Architecture Overview

Community Cloud deploys a K3s cluster across heterogeneous hardware, organizing nodes into functional roles:

| Role | Purpose |
|---|---|
| `gateway` | Publicly routable nodes serving as cluster ingress/egress, via the Gateway API on Cilium's Envoy |
| `lighthouse` | Nebula lighthouses, which nodes on other networks find each other through |
| `worker` | General-purpose workload nodes |
| `worker-gpu` | GPU-equipped nodes for AI/ML inference (AMD MI300, NVIDIA, Intel) |
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
│   ├── ai/             # vLLM GPU inference (AMD MI300), applied by hand
│   ├── apps/           # Application deployments (Twenty CRM, Lago, Documenso, Mattermost, Plane, Headlamp, etc.)
│   ├── certs/          # cert-manager values and the cluster's Let's Encrypt issuer
│   ├── crd/            # Custom Resource Definitions (Webapp), not yet applied by anything
│   ├── database/       # PostGIS
│   ├── k3s-config/     # Placeholder: K3s's node configuration is generated by the installer
│   ├── mq/             # The RabbitMQ operators, and a placeholder for NATS
│   ├── networking/     # Cilium, the cluster Gateway, Tailscale
│   ├── storage/        # TopoLVM, SeaweedFS, StorageClasses
│   └── values.example.yaml
├── headlamp/           # Community Cloud's Headlamp plugins (LGPL)
│   └── plugins/        # cc-cumulus-theme, cc-storage-explorer
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
| `Webapp` | Namespace | Declarative webapp lifecycle — deployment, service, PVC, database, Gateway API route, TLS cert |

Neither the CRD nor a controller for it is installed yet. A sketch of
the controller, which would generate deployment manifests from a simple
spec, is in `installer/src/runners/scratch/controller/WebappController.ts`;
nothing imports it. `k8s/crd/sites.crd.yaml` is meant to become a
cluster-scoped `Site`, but is currently a copy of the `Webapp` CRD.

### Applications

| App | Namespace | Status |
|---|---|---|
| Authentik | `cc-office` | Plugin — single sign on, on cc-postgres and a SeaweedFS bucket |
| Twenty CRM | `cc-office` | `twenty` package — server and worker, on cc-postgres, Redis and a SeaweedFS bucket |
| Lago | `cc-office` | `lago` package — billing, on cc-postgres, Redis and a SeaweedFS bucket |
| Plane | `cc-office` | `plane` package — projects, on cc-postgres, Redis, RabbitMQ and a SeaweedFS bucket |
| Documenso | `cc-office` | `documenso` package — document signing, through Authentik |
| Mattermost | `cc-office` | `mattermost` package — chat, through its operator, on cc-postgres and a SeaweedFS bucket |
| Headlamp | `cc-office` | `headlamp` package — cluster UI, signed into through Authentik, with our plugins |
| Picoclaw | `cc-office` | `picoclaw` package — AI agent, behind an Authentik gate |

None of these has run on real hardware in its current form yet.

### AI Inference

- **vLLM** on AMD MI300 GPUs (`k8s/ai/vLLM/vllm-amd.yaml`): Mistral-7B deployment with ROCm, host network/IPC, 8Gi shared memory, Hugging Face model access via secret. No package installs it; apply it by hand.

## Quick Start

1. **Build a configuration** with `community-cloud`, describing your nodes
2. **Enable the applications** you want under `packages`; the install brings in what they need
3. **Check it** with `community-cloud preflight cc.config.json`
4. **Install** with `community-cloud install cc.config.json` — every node is prepared, K3s installed, Cilium and the cluster Gateway set up, and then every package in dependency order

## Tech Stack

- **Runtime**: Bun (installer), K3s (Kubernetes)
- **Languages**: TypeScript, YAML
- **CLI Framework**: Commander.js, Inquirer, node-ssh
- **Storage**: TopoLVM, SeaweedFS
- **Networking**: Cilium (CNI, Gateway API, load balancer IPAM), cert-manager, Nebula, Tailscale
- **Databases and queues**: CloudNative-PG (PostgreSQL/PostGIS), Redis (Opstree), RabbitMQ (its Cluster Operator)
- **AI**: vLLM (ROCm/AMD GPU)
