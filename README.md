# Community Cloud

A multi-node, multi-site Kubernetes platform built on K3s, designed to provision and manage distributed infrastructure with automated storage, networking, and application lifecycle management.

## Architecture Overview

Community Cloud deploys a K3s cluster across heterogeneous hardware, organizing nodes into functional roles:

| Role | Purpose |
|---|---|
| `gateway` | Publicly routable nodes serving as cluster ingress/egress via Traefik (Gateway API) |
| `worker` | General-purpose workload nodes |
| `worker-gpu` | GPU-equipped nodes for AI/ML inference (AMD MI300, NVIDIA, Intel) |
| `storage-local` | Nodes with local block devices for TopoLVM CSI provisioning |
| `storage-distributed` | Nodes participating in distributed storage pools |

### Storage Architecture

Two complementary storage layers:

| Layer | Technology | Use Case |
|---|---|---|
| **Local SSD** | TopoLVM (LVM-based CSI driver) | Fast, node-local storage — default StorageClass `cc-local-ssd-fast` |

TopoLVM supports four device classes mapped to LVM volume groups:

| Device Class | Volume Group | Medium |
|---|---|---|
| `ssd` | `cc-ssd-vg` | M.2 NVMe (fastest) |
| `ssd-sata` | `cc-ssd-sata-vg` | SATA SSD |
| `ssd-cache` | `cc-ssd-cache` | SSD cache tier |
| `hdd` | `cc-hdd-vg` | Spinning disk (capacity) |

Object storage is provided by [Garage](https://garagehq.deuxfleurs.fr) (S3-compatible), deployed as a single-node StatefulSet with NodePort access.

### Networking

- **Gateway**: Traefik via Kubernetes Gateway API (`cc-gateway-class`)
- **Certificates**: cert-manager with Let's Encrypt (HTTP-01 challenges via Gateway API)
- **Cross-Site**: Tailscale integration for zero-trust networking between distributed nodes
- **Ingress**: Dedicated gateway nodes with node affinity scheduling

### Database Services

| Service | Technology | Details |
|---|---|---|
| PostgreSQL + PostGIS | CloudNative-PG | Single-instance, 30Gi SSD, PostGIS 3.6 extension |
| Redis | Opstree Operator | Standalone, 5Gi SSD |
| MariaDB | (planned) | Configuration directory prepared |

## Project Structure

```
community-cloud/
├── installer/          # CLI tool for cluster provisioning
│   ├── src/
│   │   ├── cli/        # React/Ink-based interactive UI
│   │   ├── commands/   # Node-level setup commands (LVM, K3s, etc.)
│   │   ├── controller/ # Webapp CRD manifest generator
│   │   ├── remote/     # SSH/remote host abstraction
│   │   └── util/       # K3s installation logic, GPU detection, helpers
│   └── package.json
├── k8s/                # Kubernetes manifests & Helm values
│   ├── ai/             # vLLM GPU inference (AMD MI300)
│   ├── apps/           # Application deployments (Twenty CRM, Authentik, Mattermost, etc.)
│   ├── certs/          # cert-manager issuers & certificates
│   ├── crd/            # Custom Resource Definitions (Webapp, Sites)
│   ├── database/       # PostgreSQL, PostGIS, Redis clusters
│   ├── gateway/        # Gateway API resources & Traefik config
│   ├── k3s-config/     # K3s node configuration (registries)
│   ├── networking/     # Networking (Tailscale cross-site)
│   └── storage/        # TopoLVM, Garage, StorageClasses
├── cc-headlamp/        # Headlamp Kubernetes UI plugin
├── docs/               # Documentation
└── README.md
```

### Top-Level Files

| File | Purpose |
|---|---|
| `cc.json` | Cluster host inventory — nodes, regions, registries, and config |
| `Vagrantfile` | Local dev environment — 3 Ubuntu 24.04 VMs with 3x 25GB disks each |
| `install-k3s.sh` | K3s server/agent bootstrap with Tailscale integration |
| `.gitignore` | Ignored files (secrets, cc.json, registries.yaml, etc.) |
| `LICENSE.md` | License information |
| `registries.yaml` | K3s private registry auth (GitLab) |
| `cc/` | Placeholder for future tooling |
| `docs/index.md` | Documentation index |

## Installer

The installer (`installer/`) is a Bun-based CLI that automates multi-node K3s cluster deployment:

- **Interactive UI**: Built with Ink (React CLI components) for guided node configuration
- **Remote Execution**: SSH-based remote command execution with key/password/agent auth fallback
- **Node Roles**: Automatic labeling and role assignment (`gateway`, `worker`, `storage-local`, etc.)
- **Storage Setup**: LVM2 physical/logical volume creation, TopoLVM CSI driver installation
- **K3s Provisioning**: Server/agent bootstrap, Gateway API CRD installation, cert-manager deployment
- **Registry Auth**: K3s private registry configuration
- **GPU Detection**: Automatic AMD/NVIDIA/Intel GPU identification

### Building the Installer

```bash
cd installer

# Development
bun run build

# Production binaries
bun run build:linux        # → build/community-cloud-linux-x64
bun run build:macos:arm    # → build/community-cloud-macos-arm
bun run build:macos:x64    # → build/community-cloud-macos-x64
bun run build:windows      # → build/community-cloud-win-x64
```

## Kubernetes Manifests

### Custom Resource Definitions

| CRD | Scope | Purpose |
|---|---|---|
| `Webapp` | Namespace | Declarative webapp lifecycle — deployment, service, PVC, database, Gateway API route, TLS cert |
| `Site` | Cluster | Multi-site configuration management |

The `Webapp` CRD controller (`installer/src/controller/WebappController.ts`) auto-generates deployment manifests from a simple spec, handling storage, databases, networking, and TLS provisioning.

### Applications

| App | Namespace | Status |
|---|---|---|
| Twenty CRM | `cc-office` | Deployed — server + worker deployments, Postgres, Redis, Garage S3 |
| Authentik | `cc-office` | Helm values configured — Postgres-backed auth, Garage S3 storage|
| Mattermost | `cc-office` | Operator values + secret/database/storage manifests prepared |
| Office (Back Office) | `cc-office` | Namespace prepared |
| Umami (Analytics) | — | Template directory prepared |
| Headlamp | — | K8s plugin values (`watchPlugins`) prepared |

### AI Inference

- **vLLM** on AMD MI300 GPUs (`k8s/ai/vllm-amd.yaml`): Mistral-7B deployment with ROCm, host network/IPC, 8Gi shared memory, Hugging Face model access via secret.

## Quick Start

1. **Run the installer** to provision your K3s cluster across nodes
2. **Apply k8s manifests** in order: CRDs → storage → gateway → certs → databases → apps
3. **Deploy applications** using the Webapp CRD or individual manifests

## Tech Stack

- **Runtime**: Bun (installer), K3s (Kubernetes)
- **Languages**: TypeScript, YAML
- **CLI Framework**: Ink (React), Commander.js, Inquirer
- **Storage**: TopoLVM, Garage
- **Networking**: Traefik, Gateway API, cert-manager, Tailscale
- **Databases**: CloudNative-PG (PostgreSQL/PostGIS), Redis (Opstree)
- **AI**: vLLM (ROCm/AMD GPU)
