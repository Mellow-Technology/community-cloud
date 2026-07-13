# Community Cloud Documentation

## Overview

Community Cloud is a multi-node, multi-site Kubernetes platform built on K3s. It provides an automated installer for provisioning distributed infrastructure and a collection of Kubernetes manifests for managing applications, storage, networking, and AI workloads.

---

## Installer

The installer (`installer/`) is a Bun-based CLI tool that automates K3s cluster deployment across remote hosts.

### Architecture

```
installer/
├── src/
│   ├── cli/                    # Interactive CLI
│   │   ├── index.tsx           # Entry point — renders Ink app
│   │   ├── App.tsx             # Root component — displays "Community Cloud" title + HostList
│   │   └── components/         # Reusable Ink components
│   │       ├── HostList.tsx    # Lists available hosts from cc.json
│   │       └── List.tsx        # Generic ordered/unordered list component
│   ├── commands/               # Node-level setup commands
│   │   ├── Command.ts          # Base command class with output parsing
│   │   ├── CommandBundle.ts    # XState-powered command execution engine
│   │   ├── GatewayNodes.ts     # Gateway node configuration
│   │   ├── GpuInfo.ts          # GPU detection command
│   │   ├── K8SPackage.ts       # K8s package management
│   │   ├── LVM.ts              # LVM volume group setup
│   │   ├── Network.ts          # Network interface discovery
│   │   ├── Registries.ts       # Private registry configuration
│   │   ├── base.yaml           # Base command definitions
│   │   └── lmv2.yaml           # LVM2 install definitions
│   ├── controller/             # Application controllers
│   │   └── WebappController.ts # Generates K8s manifests from Webapp CRD spec
│   ├── remote/                 # Remote host management
│   │   ├── RemoteAgent.ts      # K3s agent install + GPU labeling
│   │   └── RemoteHost.ts       # SSH connection with key/password/agent auth
│   └── util/                   # Utilities
│       ├── K3sInstallation.ts  # Server/agent install step definitions
│       ├── chalk.ts            # Styled console output helpers
│       ├── exec.ts             # Promise-based exec + JSON parsing
│       ├── gpu.ts              # GPU detection engine (NVIDIA/AMD/Intel)
│       ├── hosts.ts            # Host inventory loading (cc.json)
│       └── installer/          # Standalone installer utilities
│           ├── InstallRunner.ts
│           ├── chalk-test.ts
│           ├── inquirer-test.ts
│           ├── installer-test.ts
│           └── installer.ts
└── package.json
```

### CLI Entry Point

**Usage:** `community-cloud <operation> <ccFilePath>`

| Operation | Description |
|---|---|
| `install` | Run the Community Cloud installation process |
| `uninstall` | Uninstall Community Cloud |
| `clean` | Clean up various install steps |

The config file (e.g., `cc.json`) provides host definitions, regions, and registry credentials.

### Command Execution Engine

The installer uses a state machine powered by [XState](https://xstate.js.org/) (`CommandBundleMachine`) to execute commands sequentially:

- **States**: `idle` → `running` → `next` → `completed` / `error`
- **Context**: Tracks commands array, current index, results, and error state
- **Commands**: Each command declares its output type (`Json`, `Csv`, `Yaml`, `CommandParser`, `Custom`) and optional post-process hooks
- **Remote execution**: Commands can target a `RemoteHost` via SSH with automatic key discovery

### Remote Host Abstraction

`RemoteHost` provides SSH connectivity with three authentication strategies:

1. **Private key** — explicit path or auto-discovery from `~/.ssh/` (ed25519, rsa, ecdsa)
2. **Password** — direct password authentication
3. **SSH agent** — falls back to system ssh-agent

Key methods:
- `connect()` — establishes SSH connection
- `exec(cmd, args?)` — execute command, returns `{ stdout, stderr, parsed }`
- `execJSON<T>()` — execute and parse JSON output
- `upload(localPath, remotePath)` — file transfer
- `disconnect()` — cleanup

### Remote Agent

`RemoteAgent` extends `RemoteHost` with K3s-specific operations:

- **`installAgent(config)`** — installs K3s agent, detects GPU remotely, applies labels (`nvidia.com/gpu`, `nvidia.com/gpu.model`)
- **`applyLabels(labels)`** — labels the node via `kubectl`, with retry on kubelet not ready
- **GPU detection** — checks NVIDIA (`nvidia-smi`), AMD (`lspci` + `rocm-smi`), Intel (`lspci`) in priority order

### GPU Detection Engine

`gpu.ts` provides a pluggable detection system that discovers GPU vendor, model, count, and driver status:

| Vendor | Detection Method | Driver Check |
|---|---|---|
| **NVIDIA** | `nvidia-smi --query-gpu=name,driver_version` | Driver version present |
| **AMD** | `lspci` + `rocm-smi --version` | ROCm version string |
| **Intel** | `lspci` for Intel VGA/Display | — |

Priority order: NVIDIA > AMD > Intel. Returns `{ type, model?, count?, driversInstalled? }`.

### Command Bundle Examples

**LVM Setup** (`LVM.ts`): Discovers disks → creates physical volumes → creates volume groups, with post-process hook to filter out loop devices.

**Rook Cleanup** (`Rook.ts`): Removes `/var/lib/rook` directory and related data.

### K3s Installation Steps

**Server install sequence:**
1. Install K3s server
2. Extract K3s token
3. Configure Traefik
4. Write registries file
5. Install Gateway API CRDs (v1.4.0)
6. Label gateway nodes
7. Install cert-manager (v1.19.2)

**Agent install sequence:** (defined in `K3sInstallation.ts`, populated at runtime)

---

## Kubernetes Manifests

### Project Layout

```
k8s/
├── ai/                          # AI/ML workloads
│   ├── vllm-amd.yaml            # vLLM deployment (Mistral-7B, AMD MI300)
│   └── vllm-amd-pvc.yaml        # 50Gi PVC for model weights
├── apps/                        # Application deployments
│   ├── authentik/               # Authentik auth server (6 manifests)
│   ├── headlamp/                # Headlamp K8s UI plugin
│   ├── mattermost/              # Mattermost chat (5 manifests)
│   ├── office/                  # cc-office namespace
│   ├── twenty/                  # Twenty CRM (7 manifests)
│   ├── umami/                   # Analytics (template)
│   └── README.md
├── certs/                       # TLS certificates
│   ├── CertIssuer.yaml          # Namespaced issuer (Let's Encrypt)
│   ├── ClusterIssuer.yaml       # Cluster-wide issuer
│   ├── CertManagerValues.yaml   # cert-manager Helm values
│   └── test-resources.yaml      # Self-signed test certificate
├── crd/                         # Custom Resource Definitions
│   ├── webapps.crd.yaml         # Webapp lifecycle CRD
│   └── sites.crd.yaml           # Multi-site config CRD
├── database/                    # Database services
│   ├── Postgres/
│   │   ├── PostGISCluster.yaml  # PostGIS cluster (30Gi)
│   │   └── PostgresCCDefault.yaml  # cc-postgres cluster for apps
│   ├── Redis/
│   │   └── RedisStandalone.yaml # Redis (5Gi SSD)
│   └── MariaDB/                 # Prepared (no manifests yet)
├── gateway/                     # Gateway API / Traefik
│   ├── GatewayClass.yaml        # cc-gateway-class (Traefik)
│   └── Gateway.yaml             # community-cloud de gateway
├── k3s-config/                  # K3s node config
│   ├── registries.yaml          # GitLab registry auth
│   └── README.md
├── networking/                  # Networking
│   └── tailscale/               # Tailscale cross-site (prepared)
└── storage/                     # Storage infrastructure
    ├── StorageClass/
    │   └── cc-local-ssd-fast.yaml  # Default SSD storage class
    ├── TopoLVM/
    │   ├── TopoLVMValues.yaml        # Production TopoLVM config
    │   └── TopoLVM-defaultValues.yaml  # Upstream defaults
    ├── Garage/
    │   └── GarageValues.yaml         # Garage S3-compatible object storage
    └── README.md
```

### Custom Resource Definitions

| CRD | Scope | Purpose |
|---|---|---|
| `Webapp` | Namespace | Declarative webapp lifecycle — auto-generates deployment, service, PVC, database, Gateway API route, TLS cert |
| `Site` | Cluster | Multi-site configuration management |

The `WebappController` (`installer/src/controller/WebappController.ts`) generates manifests from a Webapp spec, handling:
- Deployment with configurable replicas, resources, env vars
- Service on port 80
- PVC with configurable size/mount path
- CloudNative-PG database cluster
- Gateway API HTTPRoute
- cert-manager Certificate

### Application Details

#### Twenty CRM (`apps/twenty/`)

Open-source CRM with server + worker architecture:

| File | Purpose |
|---|---|
| `Twenty.yaml` | Server (1 replica, port 3000) + Worker (1 replica, `yarn worker:prod`) deployments |
| `TwentyDatabase.yaml` | CloudNative-PG `Database` CRD for `twenty_crm` database |
| `Twenty.storage.yaml` | `ObjectBucketClaim` for Garage S3 (20 Gi limit) |
| `Twenty.config.yaml` | ConfigMap with server URL |
| `Twenty.install.yaml` | Init Job — runs `yarn database:init:prod` |
| `Twenty.route.yaml` | Gateway API HTTPRoute  |

#### Authentik (`apps/authentik/`)

Authentication provider with Postgres backend and Garage S3 storage:

| File | Purpose |
|---|---|
| `Authentik.values.yaml` | Helm values — Postgres integration, S3 storage |
| `Authentik.database.yaml` | CloudNative-PG `Database` CRD |
| `Authentik.storage.yaml` | ObjectBucketClaim |
| `Authentik.cert.yaml` | TLS certificate |
| `Authentik.config.yaml` | Gateway API route config |

#### Mattermost (`apps/mattermost/`)

Chat platform using Mattermost Operator:

| File | Purpose |
|---|---|
| `Mattermost.yaml` | Mattermost CRD (100 users, 2 replicas, v10.11.19) |
| `Mattermost.values.yaml` | Operator Helm values (v1.25.4, leader election, metrics) |
| `Mattermost.database.yaml` | CloudNative-PG `Database` CRD |
| `Mattermost.storage.yaml` | ObjectBucketClaim |

#### Headlamp (`apps/headlamp/`)

Kubernetes dashboard plugin:

| File | Purpose |
|---|---|
| `Headlamp.values.yaml` | Helm values with `watchPlugins: true` |
| `Headlamp.plugins.yaml` | Plugin configuration |

`cc-headlamp/` — Headlamp plugin project (TypeScript, `@kinvolk/headlamp-plugin`), with build/storybook/test tooling.

### Storage Architecture

| Layer | Technology | Details |
|---|---|---|
| **Local SSD** | TopoLVM | Default StorageClass `cc-local-ssd-fast`, XFS, Retain policy, WaitForFirstConsumer |
| **Object** | Garage | S3-compatible, NodePort 3900/3902, single-node StatefulSet |

TopoLVM device classes: `ssd` (cc-ssd-vg), `ssd-sata` (cc-ssd-sata-vg), `ssd-cache` (cc-ssd-cache), `hdd` (cc-hdd-vg).

### Database Services

| Service | Technology | Namespace | Storage |
|---|---|---|---|
| cc-postgres | CloudNative-PG (PostgreSQL 18 + PostGIS 3.6) | cc-office | 30Gi cc-local-ssd-fast |
| postgis | CloudNative-PG (PostgreSQL 18 + PostGIS 3.6) | default | 30Gi cc-local-ssd-fast |
| Redis | Opstree Operator (v7.0.15) | cc-office | 5Gi cc-local-ssd-fast |

---

## Configuration

### Host Inventory (`cc.json`)

Defines the cluster topology:

```jsonc
{
  "config": {
    "adminEmail": "[ADMIN_EMAIL]",     // cert-manager admin contact
    "letsencryptEmail": "[ACME_ACCOUNT_EMAIL]" // ACME account
  },
  "regions": [
    { "name": "Southeast Asia", "value": "se-asia" },
    { "name": "Europe", "value": "europe" }
  ],
  "registries": { /* private registry auth */ },
  "hosts": [
    {
      "name": "node-1",
      "type": "server",
      "labels": ["worker", "worker-gpu", "storage-local"],
      "useTailscale": true,
      "region": "se-asia", "zone": "th-1"
    },
    // ... more hosts
  ]
}
```

### Node Roles

| Role | Purpose |
|---|---|
| `gateway` | Public ingress nodes with stable IPs |
| `worker` | General-purpose workload nodes |
| `worker-gpu` | GPU-equipped AI/ML inference nodes |
| `storage-local` | TopoLVM CSI node/lvmd nodes |
| `storage-distributed` | Distributed storage nodes |

### AI Inference

- **vLLM** on AMD MI300 GPUs (`k8s/ai/vllm-amd.yaml`)
- Mistral-7B model, ROCm image, host network/IPC, 8Gi shared memory
- Hugging Face Hub token via secret (`hf-token-secret`)
- ClusterIP service on port 80 → container port 8888

---

## Deployment Order

1. **Provision nodes** — run installer with `cc.json`
2. **Storage** — TopoLVM → Garage
3. **Networking** — GatewayClass → Gateways → cert-manager
4. **CRDs** — Webapp, Site
5. **Databases** — cc-postgres → Redis
6. **Applications** — Twenty CRM → Authentik → Mattermost → Headlamp
7. **Routes** — Gateway API HTTPRoutes for each domain

---

## Tech Stack

| Category | Technology |
|---|---|
| **Runtime** | Bun (installer), K3s (Kubernetes) |
| **Language** | TypeScript, YAML |
| **CLI** | Ink (React), Commander.js, Inquirer |
| **State Machine** | XState (command bundle) |
| **SSH** | node-ssh, ssh2 |
| **K8s Client** | @kubernetes/client-node |
| **Storage** | TopoLVM, Garage |
| **Networking** | Traefik, Gateway API, cert-manager, Tailscale |
| **Databases** | CloudNative-PG, Redis (Opstree) |
| **AI** | vLLM (ROCm/AMD GPU) |
| **Apps** | Twenty CRM, Authentik, Mattermost, Headlamp, Umami |
| **Dev** | Vagrant (3x Ubuntu 24.04 VMs with 3x 25GB disks) |
