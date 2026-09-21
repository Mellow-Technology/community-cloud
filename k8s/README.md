# Community Cloud Kubernetes Manifests

The manifests and Helm values that make up a Community Cloud cluster.

Most files here are templates. They're written the way Helm charts are
— `{{ .Values.domain.main }}` and so on — and rendered against a
Community Cloud configuration before being applied. `k8s/values.example.yaml`
shows the shape those values take; the real ones come from
`cc.config.json`. See the [installer README](../installer/README.md#configuration).

Nothing here needs to be applied by hand:

```bash
community-cloud run-template embed://gateway/Gateway.yaml cc.config.json
community-cloud list-embedded            # everything the installer carries
```

The whole directory is compiled into the installer binary, so a
released executable can apply any of it on a machine that has never
seen this repository.

## Naming

A file called `Thing.values.yaml` is Helm values for a chart. Anything
else is a manifest applied with `kubectl`. Where an application needs
several pieces, they're split by what they are — `.database.yaml`,
`.storage.yaml`, `.cert.yaml`, `.route.yaml` — so they can be applied
in a sensible order and read one at a time.

## Directory structure

```
k8s/
├── ai/vLLM/           # Large language model serving
├── apps/              # The applications a cluster runs
│   ├── authentik/     # Identity provider
│   ├── headlamp/      # Kubernetes UI
│   ├── mattermost/    # Team chat
│   ├── office/        # The cc-office namespace and its shared pieces
│   ├── picoclaw/      # Picoclaw
│   └── twenty/        # Twenty CRM
├── certs/             # cert-manager and its issuers
├── crd/               # Community Cloud's own custom resources
├── database/Postgres/ # CloudNativePG clusters
├── gateway/           # The default application Gateway
├── networking/        # CNI, the Gateway API, the mesh
│   ├── cilium/
│   ├── gateway/
│   └── tailscale/
└── storage/           # Local and object storage
    ├── Garage/
    ├── StorageClass/
    └── TopoLVM/
```

## Networking (`networking/`)

| File | What it is |
|---|---|
| `cilium/Cilium.values.yaml` | Cilium's Helm values. The CNI, the kube-proxy replacement, the Gateway API implementation and the load balancer IP management all come from here. |
| `gateway/Gateway.yaml` | The cluster's default Gateway, served by Cilium's Envoy. Uses `allowedListeners` so only namespaces labelled `whereWereGoing=weDontNeedRoads` may attach listeners. |
| `tailscale/Tailscale.proxy.yaml` | A Tailscale proxy, for reaching a cluster across networks. |

Cilium replaces a good deal of what K3s ships with. The installer
starts K3s with `--disable=traefik --disable=servicelb`, installs the
Gateway API resources itself at a pinned version, and then installs
Cilium — in that order, because Cilium's operator builds its Gateway
API controller once at startup from whatever it finds then.

## Gateway (`gateway/`)

| File | What it is |
|---|---|
| `Gateway.yaml` | The default Gateway for applications, with the Let's Encrypt listeners. |

## Certificates (`certs/`)

| File | What it is |
|---|---|
| `CertManager.values.yaml` | cert-manager's Helm values. |
| `ClusterIssuer.yaml` | A cluster-wide Let's Encrypt issuer. |

## Storage (`storage/`)

| File | What it is |
|---|---|
| `TopoLVM/TopoLVM.values.yaml` | TopoLVM's Helm values, and the source of truth for the device classes. |
| `StorageClass/cc-local-ssd-fast.yaml` | The cluster default: XFS on the `ssd` device class, `Retain`, expandable. |
| `StorageClass/cc-local-ssd-sata.yaml` | The same on `ssd-sata`. |
| `Garage/GarageValues.yaml` | Garage, S3-compatible object storage. |

See [storage/README.md](./storage/README.md).

## Applications (`apps/`)

See [apps/README.md](./apps/README.md).

## Custom resources (`crd/`)

| File | What it is |
|---|---|
| `sites.crd.yaml` | A `Site`: a physical location and what runs there. |
| `webapps.crd.yaml` | A `WebApp`: an application with a domain, an image and storage. |

## Databases (`database/`)

| File | What it is |
|---|---|
| `Postgres/PostGISCluster.yaml` | A CloudNativePG cluster with PostGIS. |

CloudNativePG is used for every Postgres in the cluster, including the
ones charts would otherwise bundle themselves. One way of running
Postgres is easier to back up, upgrade and reason about than four.

## AI workloads (`ai/`)

| File | What it is |
|---|---|
| `vLLM/vllm-amd.yaml` | vLLM on AMD GPUs, via ROCm. |
| `vLLM/vllm-amd-pvc.yaml` | Its model storage. |

Scheduled onto nodes labelled `node-role.kubernetes.io/worker-gpu`,
which the installer applies automatically to any node it finds a
compute-capable GPU on.

## Applying in order

Some of this depends on the rest of it. Broadly:

1. **Cilium**, before anything expects a network
2. **Gateway API resources and the Gateway**, before anything expects an address
3. **cert-manager and the ClusterIssuer**, before anything expects a certificate
4. **TopoLVM and the StorageClasses**, before anything expects a volume
5. **CloudNativePG**, before anything expects a database
6. **Applications**

The installer works most of this out: `community-cloud run-bundle
helm-charts <node> cc.config.json` installs the configured charts in
dependency order.
