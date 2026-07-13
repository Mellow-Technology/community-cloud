# Community Cloud — Storage

This directory contains Kubernetes YAML configurations for the various storage components that power Community Cloud. It covers local storage provisioning, distributed block storage, and object storage.

## Directory Structure

```
storage/
├── StorageClass/          # Custom StorageClass definitions
│   └── cc-local-ssd-fast.yaml
├── TopoLVM/              # TopoLVM CSI driver configuration
│   ├── TopoLVMValues.yaml
│   └── TopoLVM-defaultValues.yaml
└── Garage/               # Garage object storage
    └── GarageValues.yaml
```

## Components

### Storage Class

| File | Description |
|---|---|
| `StorageClass/cc-local-ssd-fast.yaml` | Defines the **default** StorageClass `cc-local-ssd-fast` for node-local M.2 SSD storage. |

**`cc-local-ssd-fast`** is set as the cluster's default StorageClass. It:

- Uses **XFS** as the filesystem and the **`ssd`** TopoLVM device class.
- Is provisioned via **TopoLVM** (`topolvm.io`).
- Has **manual reclaim** (`Retain`) to prevent accidental data loss.
- Supports **volume expansion** (`allowVolumeExpansion: true`).
- Uses **`WaitForFirstConsumer`** binding mode for optimal pod scheduling.

### TopoLVM

| File | Description |
|---|---|
| `TopoLVM/TopoLVMValues.yaml` | Production values for the TopoLVM Helm chart (device classes, node selectors, etc.). |
| `TopoLVM/TopoLVM-defaultValues.yaml` | Default Helm chart values for the TopoLVM project (reference / upstream defaults). |

TopoLVM provides **LVM-based local storage** as a Kubernetes CSI driver. It supports multiple device classes:

| Device Class | Purpose | Volume Group |
|---|---|---|
| `ssd` | M.2 SSDs (fastest) | `cc-ssd-vg` |
| `ssd-sata` | SATA SSDs | `cc-ssd-sata-vg` |
| `ssd-cache` | SSD cache for HDDs | `cc-ssd-cache` |
| `hdd` | Spinning drives (highest capacity) | `cc-hdd-vg` |

All TopoLVM components (controller, lvmd, node) are scheduled only on nodes labeled `node-role.kubernetes.io/storage-local=storage-local`.

### Garage

| File | Description |
|---|---|
| `Garage/GarageValues.yaml` | Helm values for the Garage object storage chart. |

Garage is an **S3-compatible object storage** solution. Key configuration:

- **1 replica** (StatefulSet) — suitable for development / single-node deployments.
- Uses `cc-local-ssd-fast` StorageClass for both metadata (300 Mi) and data (200 Gi).
- Exposes S3 API via **NodePort** on port **3900** (API) and **3902** (web).
- Monitoring (Prometheus metrics / ServiceMonitor) is available but disabled by default.
- Ingress configuration is commented out — enable and configure as needed.

## Deployment Notes

1. **Prerequisites** — Nodes must have the appropriate labels:
   - `node-role.kubernetes.io/storage=storage` (for Rook / TopoLVM controller)
   - `node-role.kubernetes.io/storage-local=storage-local` (for TopoLVM node/lvmd)

2. **Default StorageClass** — `cc-local-ssd-fast` is the cluster default. PVCs without an explicit `storageClassName` will use local SSD storage.

3. **Garage** — Currently configured for single-node deployment. For production, increase `replicaCount` and set `replicationFactor` accordingly (see [Garage documentation](https://garagehq.deuxfleurs.fr)).
