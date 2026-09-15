# Community Cloud Documentation

## Overview

Community Cloud is a multi-node, multi-site Kubernetes platform built on K3s. It provides an automated installer for provisioning distributed infrastructure and a collection of Kubernetes manifests for managing applications, storage, networking, and AI workloads.

---

## Installer

The installer (`installer/`) is a Bun CLI that builds and inspects
clusters. It ships as a single executable with every manifest under
`k8s/` compiled into it, so it needs nothing on the machine it runs
from — no Bun, no Node, no checkout.

Full configuration reference: [installer/README.md](../installer/README.md#configuration).

### Commands

| Command | What it does |
|---|---|
| `configure` | Build or edit a configuration, interactively. The default when no command is given. |
| `preflight <config>` | Say whether a configuration could be installed, before installing it. Changes nothing. |
| `doctor <config>` | Ask a running cluster how it's doing. Changes nothing. |
| `run-bundle <bundle> <node> <config>` | Run one bundle against one node. |
| `run-pipeline <pipeline> <node> <config>` | Run several bundles in order, passing findings along. |
| `run-template <manifest> <config>` | Render a manifest and apply or delete it with kubectl. |
| `list-bundles`, `list-embedded` | What there is to run, and what the binary carries. |

### Architecture

```
installer/
├── scripts/
│   ├── build.ts               # Cross-compiles for eight targets
│   └── generateEmbedded.ts    # Compiles k8s/ into a SQLite database
└── src/
    ├── cli/
    │   ├── installer.ts       # Entry point, commander definitions
    │   ├── commands/          # What can be done to a node or cluster
    │   └── configure/         # The interactive configuration builder
    ├── runners/               # What drives the commands
    ├── remote/                # SSH, and ~/.ssh/config resolution
    ├── topology/              # The fixed region list
    ├── util/                  # Config, templating, shell, redaction
    └── generated/             # The embedded manifest database
```

### Commands and bundles

A **command** is one step: a shell command on a node, or an HTTP call
to an API. A **bundle** is an ordered list of them aimed at one node,
sharing a context so that what one finds is available to the next —
the GPU bundle detects hardware, and the labelling bundle puts the
right role on the node because of it.

Every command declares two things about itself.

**Where it runs.** Most belong on the node the bundle is aimed at.
Anything using kubectl doesn't, because only a server has a
kubeconfig, so it says `runOn: ControlPlane` and the runner opens the
connection it needs. That's what lets a bundle read the hardware on an
agent and then label it — impossible from the agent itself.

**What it's for**, which is mostly whether it changes anything:

| Purpose | Meaning |
|---|---|
| `Inspect` | Reads and reports. Every answer is a valid answer. |
| `Require` | Reads, and demands a particular answer before work starts. |
| `Verify` | Reads, and demands that a change took. |
| `Settle` | Waits for a change to finish. Changes nothing, but can block. |
| `Apply` | Changes something. The default, so an unlabelled command is never run by anything that promised only to look. |

`doctor` and `preflight` are built on that: they ask a bundle for only
the purposes that change nothing, so they're safe to point at a
cluster in service.

### Bundles

| Bundle | What it does |
|---|---|
| `preflight` | Whether a node could be installed on at all |
| `base` | The packages every node needs |
| `network` | Kernel networking — BBR congestion control, fair queueing |
| `k3s` | K3s, as a server or an agent depending on the node |
| `cilium` | The Gateway API resources, then Cilium as the CNI |
| `gateway` | A way into the cluster from outside |
| `lvm` | Volume groups for TopoLVM to carve volumes from |
| `gpu` | What video hardware a node has, and whether its tooling is installed |
| `nodeLabels` | Roles, labels, and what was detected |
| `registries` | Credentials for private registries |
| `helm`, `helm-charts` | Helm, then the configured charts in dependency order |
| `nebula`, `nebula-network` | A Defined Networking mesh |
| `cluster` | Records the configuration in the cluster itself |

### Secrets

Anything on a command line is readable by every user on a node through
a process listing, and is quoted back in error messages. So a command
can take a payload on `stdin` — a registry password, a rendered
manifest — or declare `secretEnv`, which travels over standard input
and is exported by a preamble on the far side. The K3s token, registry
credentials and Nebula enrolment codes all go that way.

### What the cluster knows about itself

The `cluster` bundle writes the configuration into the cluster as a
ConfigMap in `kube-system` called `community-cloud`, with the secrets
stripped out. Finding it is how anything can tell this is a Community
Cloud cluster; reading it is how `doctor` reports where a cluster has
drifted from the file it was built from.

## Kubernetes Manifests

### Project Layout

```
k8s/
├── ai/                          # AI/ML workloads
│   └── vLLM/
│       ├── vllm-amd.yaml        # vLLM deployment (Mistral-7B, AMD MI300)
│       └── vllm-amd-pvc.yaml    # PVC for model weights
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
├── gateway/                     # The default application Gateway
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
    │   └── TopoLVM.values.yaml       # TopoLVM values, and the device classes
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
| `Twenty.database.yaml` | CloudNativePG `Database` for the `twenty_crm` database |
| `Twenty.storage.yaml` | `ObjectBucketClaim` for Garage S3 (20 Gi limit) |
| `Twenty.config.yaml` | ConfigMap with server URL |
| `Twenty.install.yaml` | Init Job — runs `yarn database:init:prod` |
| `Twenty.route.yaml` | Gateway API HTTPRoute |
| `Twenty.cert.yaml` | Its certificate |
| `Twenty.network.yaml` | Network policy |

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

### The configuration file

A cluster is described by one JSON file, conventionally
`cc.config.json` — nodes, networking, storage, packages, registries.
It holds secrets (the cluster token, registry passwords, a Nebula API
key) and is gitignored as `*.config.json`.

**The full reference is in [installer/README.md](../installer/README.md#configuration)**,
which documents every key the installer reads. A sketch:

```jsonc
{
  "config": { "adminEmail": "you@example.com" },
  "k3s": { "token": "a-long-shared-secret" },
  "values": { "domain": { "main": "example.com" } },
  "network": {
    "gateway": { "mode": "port-forward", "addresses": ["192.168.1.240-192.168.1.250"] }
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

Build one with `community-cloud` and no arguments, and check it with
`community-cloud preflight cc.config.json` before installing anything.

### Node Roles

| Role | Purpose |
|---|---|
| `gateway` | Public ingress nodes with stable IPs |
| `worker` | General-purpose workload nodes |
| `worker-gpu` | GPU-equipped AI/ML inference nodes |
| `storage-local` | TopoLVM CSI node/lvmd nodes |
| `storage-distributed` | Distributed storage nodes |

### AI Inference

- **vLLM** on AMD MI300 GPUs (`k8s/ai/vLLM/vllm-amd.yaml`)
- Mistral-7B model, ROCm image, host network/IPC, 8Gi shared memory
- Hugging Face Hub token via secret (`hf-token-secret`)
- ClusterIP service on port 80 → container port 8888

---

## Deployment Order

1. **Provision nodes** — `community-cloud preflight`, then the `k3s` bundle
2. **Storage** — TopoLVM → Garage
3. **Networking** — Cilium → Gateway API → the cluster Gateway → cert-manager
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
| **Networking** | Cilium (CNI, Gateway API, load balancer IPAM), cert-manager, Nebula, Tailscale |
| **Databases** | CloudNative-PG, Redis (Opstree) |
| **AI** | vLLM (ROCm/AMD GPU) |
| **Apps** | Twenty CRM, Authentik, Mattermost, Headlamp, Umami |
| **Dev** | Vagrant (3x Ubuntu 24.04 VMs with 3x 25GB disks) |
