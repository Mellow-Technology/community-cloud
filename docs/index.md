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
| `doctor <config>` | Ask a running cluster how it's doing, every node at once. Changes nothing. |
| `install <config>` | Build the whole cluster, every node in lock step. |
| `add-node <node> <config>` | Add an agent to a cluster that already exists. |
| `uninstall <node> <config>` | Take one node out of the cluster and K3s off it, keeping its data. |
| `clean <node\|all> <config>` | Remove the configuration and data an uninstall kept. |
| `run-bundle <bundle> <node\|all> <config>` | Run one bundle against one node or every node. |
| `run-pipeline <pipeline> <node\|all> <config>` | Run several bundles in order, passing findings along. |
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
| `cluster-online` | Whether the cluster is up, before joining a node to it |
| `node-joined` | Whether a node has joined the cluster and gone Ready |
| `registries` | Credentials for private registries |
| `helm`, `helm-charts` | Helm, then the configured charts in dependency order |
| `dns` | ExternalDNS, one per DNS provider account and namespace, publishing routed hostnames |
| `lago`, `documenso`, `twenty`, `mattermost`, `picoclaw`, `plane` | One application on its own, into a cluster that has the rest |
| `nebula`, `nebula-network` | A Defined Networking mesh |
| `cluster` | Records the configuration in the cluster itself |

These install one package on its own. Their checks
are that package's, which `helm-charts` already asks for every
package the configuration enables, so a check-up of everything leaves
them out — otherwise a cluster without Lago would be reported as
having a broken one. `doctor --bundle lago` still asks.
A package installed with `run-bundle` alone should be enabled under
`packages` too, so the doctor knows to ask about it.

The bundles below take a cluster apart rather than building one. Their
checks assert the opposite of a working cluster — "K3s isn't running
here", "this node isn't a member" — so a check-up that asks about
everything leaves them out, and `doctor --bundle <name>` runs them
when the question is meant.

| Bundle | What it does |
|---|---|
| `drain` | Moves the workloads off a node, respecting disruption budgets |
| `k3s-uninstall` | Stops K3s and removes it, keeping every directory it was using |
| `node-removed` | Removes a node from the cluster, and checks the cluster agrees |
| `clean` | Removes the directories `k3s-uninstall` kept |
| `storage-remove` | Destroys the volume groups, and everything stored in them |

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
├── ai/vLLM/                     # vLLM deployment and its model PVC (AMD MI300)
├── apps/                        # Application deployments
│   ├── authentik/               # Authentik, installed by its plugin
│   ├── documenso/               # Documenso document signing
│   ├── headlamp/                # Headlamp cluster UI, signed into through Authentik, with our plugins
│   ├── lago/                    # Lago billing, on cc-postgres, the shared Redis and SeaweedFS
│   ├── mattermost/              # Mattermost chat, through its operator
│   ├── office/                  # cc-office namespace, cc-postgres, its roles, the shared Redis and RabbitMQ
│   ├── picoclaw/                # Picoclaw AI agent, behind an Authentik gate
│   ├── plane/                   # Plane projects, on cc-postgres, Redis, RabbitMQ and SeaweedFS
│   ├── twenty/                  # Twenty CRM
│   └── README.md
├── certs/
│   ├── CertManager.values.yaml  # cert-manager Helm values
│   └── ClusterIssuer.yaml       # cc-lets-encrypt, applied by the cert-manager package
├── crd/                         # Custom Resource Definitions
│   ├── webapps.crd.yaml         # Webapp lifecycle CRD
│   └── sites.crd.yaml           # Multi-site config CRD
├── database/Postgres/
│   └── PostGISCluster.yaml      # PostGIS cluster (30Gi)
├── k3s-config/README.md         # K3s node config notes
├── mq/
│   ├── RabbitMQ/                # The RabbitMQ operators, vendored at pinned versions
│   └── nats/README.md           # NATS (prepared)
├── networking/
│   ├── cilium/
│   │   ├── Cilium.values.yaml   # Cilium Helm values
│   │   └── gateway/Gateway.yaml # cc-letsencrypt-web-gateway, made by the gateway bundle
│   └── tailscale/               # Tailscale cross-site (prepared)
├── storage/                     # Storage infrastructure
│   ├── StorageClass/            # cc-local-ssd-fast (default) and cc-local-ssd-sata
│   ├── TopoLVM/
│   │   └── TopoLVM.values.yaml  # TopoLVM values, and the device classes
│   ├── SeaweedFS/
│   │   ├── SeaweedFS.namespace.yaml  # Its namespace, labelled for the cluster Gateway
│   │   ├── SeaweedFS.yaml            # The SeaweedFS cluster, and which namespaces may keep buckets
│   │   └── SeaweedFS.network.yaml    # S3 on values.domain.storage
│   └── README.md
└── values.example.yaml          # The values the templates read
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

Open-source CRM, installed by the `twenty` package, on cc-postgres, the
shared Redis and a SeaweedFS bucket:

| File | Purpose |
|---|---|
| `Twenty.yaml` | Server (migrates as it starts, `/healthz` probes) and worker deployments, and the Service |
| `Twenty.database.yaml` | CloudNativePG `Database` for the `twenty_crm` database |
| `Twenty.storage.yaml` | Its SeaweedFS bucket (20 Gi quota), user and keys |
| `Twenty.config.yaml` | Its settings: server URL, bucket, mail |
| `Twenty.network.yaml` | ListenerSet on the cluster Gateway, route and HTTPS redirect |

#### Authentik (`apps/authentik/`)

Authentication provider, installed by the Authentik plugin (chart
2026.8.5), with Postgres in cc-postgres and files in SeaweedFS:

| File | Purpose |
|---|---|
| `Authentik.values.yaml` | Helm values — Postgres integration, S3 storage, mail |
| `Authentik.database.yaml` | CloudNative-PG `Database` CRD |
| `Authentik.storage.yaml` | Its SeaweedFS bucket (20 Gi quota), user and keys |
| `Authentik.network.yaml` | ListenerSet on the cluster Gateway, route and HTTPS redirect |

#### Plane (`apps/plane/`)

Projects, issues and docs. The `plane` package or bundle installs it,
and `cloudnative-pg`, `redis-operator`, `rabbitmq-operator` and
`seaweedfs` with it. Its free edition has no OpenID Connect, so it
keeps its own accounts, with sign up off and its first administrator
made by the install:

| File | Purpose |
|---|---|
| `Plane.yaml` | API (migrations and the first administrator in init containers), worker, scheduler (`Recreate`), live server, and the web, space and admin apps |
| `Plane.database.yaml` | Its role and database in cc-postgres |
| `Plane.queue.yaml` | Its vhost, user and permission in the shared RabbitMQ |
| `Plane.bucket.yaml` | Its SeaweedFS bucket, `uploads`, user and keys |
| `Plane.config.yaml` | Its settings, the live server's, and the script that makes its first administrator |
| `Plane.network.yaml` | ListenerSet on the cluster Gateway, routes by path, `/uploads` to SeaweedFS and the ReferenceGrant allowing it |

#### Lago (`apps/lago/`)

Billing: plans, subscriptions, usage and invoices. Lago has no OpenID
Connect, so it keeps its own accounts, with sign up switched off. The
`lago` package or bundle installs it, and the `redis-operator` and
`seaweedfs` packages with it:

| File | Purpose |
|---|---|
| `Lago.yaml` | API (migrations in an init container), worker, and clock (1 replica, `Recreate`) |
| `Lago.front.yaml` | The web app |
| `Lago.pdf.yaml` | Gotenberg, which renders invoices as PDFs |
| `Lago.database.yaml` | Its role and database in cc-postgres |
| `Lago.bucket.yaml` | Its SeaweedFS bucket for PDFs, exports and logos, and keys to only that |
| `Lago.config.yaml` | Its environment, the web app's, and an initializer that serves files through the API |
| `Lago.network.yaml` | ListenerSet on the cluster Gateway for the web app and the API, and their routes |

#### Documenso (`apps/documenso/`)

Document signing, signed into through Authentik over OpenID Connect,
with passwords switched off. The `documenso` package or bundle
installs it:

| File | Purpose |
|---|---|
| `Documenso.yaml` | The application (1 replica), with its signing certificate mounted |
| `Documenso.database.yaml` | Its CloudNative-PG role and `Database` — documents are stored there too |
| `Documenso.config.yaml` | Its environment |
| `Documenso.network.yaml` | ListenerSet on the cluster Gateway, and its routes |
| `Documenso.blueprint.yaml` | Authentik blueprint for its client — not a manifest |

#### Mattermost (`apps/mattermost/`)

Chat, installed by the `mattermost` package through the Mattermost operator, on cc-postgres and a SeaweedFS bucket:

| File | Purpose |
|---|---|
| `Mattermost.yaml` | Mattermost installation (100 users, 1 replica, v10.11.19), external database and file store |
| `Mattermost.values.yaml` | Operator Helm values (chart 1.0.5, operator v1.25.4) |
| `Mattermost.database.yaml` | CloudNative-PG `Database` CRD |
| `Mattermost.storage.yaml` | Its SeaweedFS bucket (30 Gi quota), user and keys |
| `Mattermost.network.yaml` | Service, ListenerSet and routes on the cluster Gateway |

#### Headlamp (`apps/headlamp/`)

Cluster web UI, installed by the `headlamp` package (chart 0.46.0).
People sign in through Authentik over OpenID Connect, and Headlamp
uses their token with the API server, which the package has trust
Authentik:

| File | Purpose |
|---|---|
| `Headlamp.values.yaml` | Helm values: OpenID Connect, the plugins mounted, no permissions of its own |
| `Headlamp.blueprint.yaml` | Authentik blueprint for its client — not a manifest |
| `Headlamp.plugins.yaml` | Community Cloud's plugins, a ConfigMap each |
| `Headlamp.rbac.yaml` | cluster-admin for `oidc:<clusterAdminGroup>` |
| `Headlamp.network.yaml` | ListenerSet on the cluster Gateway, route and HTTPS redirect |

`headlamp/plugins/` at the top of the repository holds Community
Cloud's own Headlamp plugins, `cc-cumulus-theme` and
`cc-storage-explorer`, built and carried inside the installer.

#### Picoclaw (`apps/picoclaw/`)

AI agent with a web console, installed by the `picoclaw` package
behind an Authentik gate:

| File | Purpose |
|---|---|
| `Picoclaw.yaml` | The agent and console (1 replica, `Recreate`), and their Service |
| `Picoclaw.config.yaml` | The configuration it starts with, copied to its volume once |
| `Picoclaw.storage.yaml` | Its home volume |
| `Picoclaw.network.yaml` | ListenerSet on the cluster Gateway, and a route to its gate |

### Storage Architecture

| Layer | Technology | Details |
|---|---|---|
| **Local SSD** | TopoLVM | Default StorageClass `cc-local-ssd-fast`, XFS, Retain policy, WaitForFirstConsumer |
| **Object** | SeaweedFS | S3-compatible, run by the SeaweedFS operator: one master, volume server, filer and S3 gateway, `seaweed-s3:8333` inside the cluster and `values.domain.storage` outside, for signed links; data volume sized from `storage.allocations.objectStorageGb`; buckets and keys per application |

TopoLVM device classes: `ssd` (cc-ssd-vg), `ssd-sata` (cc-ssd-sata-vg), `ssd-cache` (cc-ssd-cache), `hdd` (cc-hdd-vg).

### Database Services

| Service | Technology | Namespace | Storage |
|---|---|---|---|
| cc-postgres | CloudNative-PG (PostgreSQL 18 + PostGIS 3.6) | cc-office | `storage.allocations.databaseGb` (30Gi by default) on cc-local-ssd-fast |
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
2. **Networking** — Cilium → Gateway API → the cluster Gateway (the
   `gateway` bundle)
3. **Charts** — the `helm-charts` bundle, dependencies first:
   cert-manager and its ClusterIssuer → TopoLVM → SeaweedFS →
   CloudNativePG and cc-postgres → Redis → Authentik (plugin) → the
   applications, each with its own ListenerSet on the cluster Gateway

---

## Design documents

Proposals, not descriptions of what exists. Each says so at the top.

| Document | What it covers |
|---|---|
| [Plugins](plugins.md) | Packaging commands, manifests and charts as loadable plugins — the seams in the installer, single-file distribution, and the trust model. **Draft, nothing built.** |

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
| **Storage** | TopoLVM, SeaweedFS |
| **Networking** | Cilium (CNI, Gateway API, load balancer IPAM), cert-manager, Nebula, Tailscale |
| **Databases** | CloudNative-PG, Redis (Opstree) |
| **AI** | vLLM (ROCm/AMD GPU) |
| **Apps** | Authentik, Twenty CRM, Lago, Documenso, Mattermost, Headlamp, Picoclaw |
| **Dev** | Vagrant (3x Ubuntu 24.04 VMs with 3x 25GB disks) |
