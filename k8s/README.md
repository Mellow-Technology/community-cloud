# Community Cloud Kubernetes Manifests

The manifests and Helm values that make up a Community Cloud cluster.

Most files here are templates. They're written the way Helm charts are
— `{{ .Values.domain.main }}` and so on — and rendered against a
Community Cloud configuration before being applied. `k8s/values.example.yaml`
shows the shape those values take; the real ones come from
`cc.config.json`. See the [installer README](../installer/README.md#configuration).

Almost nothing here needs to be applied by hand: the installer applies
each file as part of the bundle or package it belongs to. The
exceptions, which nothing applies yet, are `crd/`,
`database/Postgres/PostGISCluster.yaml`, `ai/vLLM/` and
`networking/tailscale/Tailscale.proxy.yaml`.

To see one as it would be applied, or what the installer carries:

```bash
community-cloud run-template embed://networking/cilium/gateway/Gateway.yaml cc.config.json --dry-run
community-cloud list-embedded            # everything the installer carries
```

Leave out `--dry-run` and `run-template` applies the file, with
whatever kubeconfig this machine has.

The whole directory is compiled into the installer binary, so a
released executable can apply any of it on a machine that has never
seen this repository.

## Naming

A file called `Thing.values.yaml` is Helm values for a chart. Anything
else is a manifest applied with `kubectl`. Where an application needs
several pieces, they're split by what they are — `.database.yaml`,
`.storage.yaml`, `.config.yaml`, `.network.yaml` — so they can be read
one at a time.

## Directory structure

```
k8s/
├── ai/vLLM/           # Large language model serving
├── apps/              # The applications a cluster runs
│   ├── authentik/     # Identity provider
│   ├── documenso/     # Document signing
│   ├── headlamp/      # Kubernetes UI
│   ├── lago/          # Billing
│   ├── mattermost/    # Team chat
│   ├── office/        # The cc-office namespace and its shared pieces
│   ├── picoclaw/      # AI agent
│   ├── plane/         # Projects
│   └── twenty/        # Twenty CRM
├── certs/             # cert-manager and the cluster's issuer
├── crd/               # Community Cloud's own custom resources
├── database/Postgres/ # CloudNativePG clusters
├── k3s-config/        # Placeholder: the installer generates K3s's configuration
├── mq/                # Message queues: the RabbitMQ operators, and a placeholder for NATS
├── networking/        # CNI, the Gateway API, the mesh
│   ├── cilium/        # Cilium, and gateway/ with the cluster Gateway
│   └── tailscale/
├── storage/           # Local and object storage
│   ├── SeaweedFS/
│   ├── StorageClass/
│   └── TopoLVM/
└── values.example.yaml # The shape of the values templates read
```

## Networking (`networking/`)

| File | What it is |
|---|---|
| `cilium/Cilium.values.yaml` | Cilium's Helm values. The CNI, the kube-proxy replacement, the Gateway API implementation and the load balancer IP management all come from here. |
| `cilium/gateway/Gateway.namespace.yaml` | `community-cloud`, for what runs the cluster: the Gateway, operators without a namespace of their own, and Headlamp. Labelled so Headlamp's ListenerSet may attach. |
| `cilium/gateway/Gateway.yaml` | The cluster's Gateway, `cc-letsencrypt-web-gateway`, served by Cilium's Envoy. Made by the `gateway` bundle, after its namespace. Uses `allowedListeners` so only namespaces labelled `whereWereGoing=weDontNeedRoads` may attach listeners. |
| `tailscale/Tailscale.proxy.yaml` | A Tailscale ingress ProxyGroup, for reaching cluster services over a tailnet. Needs the `tailscale-operator` package, and is applied by hand. |

Cilium replaces a good deal of what K3s ships with. The installer
starts K3s with `--disable=traefik --disable=servicelb`, installs the
Gateway API resources itself at a pinned version, and then installs
Cilium — in that order, because Cilium's operator builds its Gateway
API controller once at startup from whatever it finds then.

The Gateway itself has only a placeholder listener, since a Gateway has
to have one. Each application brings its own HTTPS listeners, and their
Let's Encrypt certificates, in a ListenerSet attached to it.

## Certificates (`certs/`)

| File | What it is |
|---|---|
| `CertManager.values.yaml` | cert-manager's Helm values. |
| `ClusterIssuer.yaml` | `cc-lets-encrypt`, the Let's Encrypt issuer every application's certificate comes from. Applied by the `cert-manager` package. |

## Storage (`storage/`)

| File | What it is |
|---|---|
| `TopoLVM/TopoLVM.values.yaml` | TopoLVM's Helm values, and the source of truth for the device classes. |
| `StorageClass/cc-local-ssd-fast.yaml` | The cluster default: XFS on the `ssd` device class, `Retain`, expandable. |
| `StorageClass/cc-local-ssd-sata.yaml` | The same on `ssd-sata`. |
| `SeaweedFS/SeaweedFS.namespace.yaml` | Its namespace, labelled for the cluster Gateway. |
| `SeaweedFS/SeaweedFS.yaml` | The SeaweedFS cluster the operator runs, and which namespaces may keep buckets in it. |
| `SeaweedFS/SeaweedFS.network.yaml` | S3 on `values.domain.storage`, for signed links. |

See [storage/README.md](./storage/README.md).

## Applications (`apps/`)

See [apps/README.md](./apps/README.md).

## Custom resources (`crd/`)

| File | What it is |
|---|---|
| `sites.crd.yaml` | Meant to become a `Site`, a physical location and what runs there. Currently a copy of the WebApp CRD. |
| `webapps.crd.yaml` | A `WebApp`: an application with a domain, an image and storage. |

Nothing applies these yet, and nothing reconciles them.

## Databases (`database/`)

| File | What it is |
|---|---|
| `Postgres/PostGISCluster.yaml` | A CloudNativePG cluster with PostGIS, in `default`. Applied by hand; the applications' `cc-postgres` is in `apps/office/`. |

CloudNativePG is used for every Postgres in the cluster, including the
ones charts would otherwise bundle themselves. One way of running
Postgres is easier to back up, upgrade and reason about than four.

## AI workloads (`ai/`)

| File | What it is |
|---|---|
| `vLLM/vllm-amd.yaml` | vLLM on AMD GPUs, via ROCm. |
| `vLLM/vllm-amd-pvc.yaml` | Its model storage. |

Applied by hand, into `default`. It doesn't select a node yet; the
installer labels any node it finds a compute-capable GPU on
`node-role.kubernetes.io/worker-gpu`, which is what it should select.

## Applying in order

Some of this depends on the rest of it. Broadly:

1. **Cilium**, before anything expects a network
2. **Gateway API resources and the Gateway**, before anything expects an address
3. **cert-manager and the ClusterIssuer**, before anything expects a certificate
4. **TopoLVM and the StorageClasses**, before anything expects a volume
5. **CloudNativePG**, before anything expects a database
6. **Applications**

`community-cloud install` does all of it in this order: the `cilium`
bundle installs the Gateway API resources and then Cilium, the
`gateway` bundle makes the Gateway, and `helm-charts` installs every
configured package — cert-manager, TopoLVM, CloudNativePG, the
applications — in dependency order.
