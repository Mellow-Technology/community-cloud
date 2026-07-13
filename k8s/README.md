# Community Cloud Kubernetes Manifests

This directory contains the Kubernetes manifests, configurations, and custom resource definitions (CRDs) used to deploy and manage the Community Cloud infrastructure across multiple nodes and sites. The manifests are organized by functional area to provide a clear structure for deployment and maintenance.

## Directory Structure

```
k8s/
├── ai/                    # AI/ML workload manifests (vLLM, GPU inference)
├── certs/                 # Certificate management (cert-manager, Let's Encrypt)
├── crd/                   # Custom Resource Definitions (CRDs)
├── database/              # Database cluster manifests (PostgreSQL, PostGIS)
├── gateway/               # Gateway API configurations (Traefik, Nginx)
├── k3s-config/            # K3s-specific configurations (registries)
└── storage/               # Storage configurations (TopoLVM, PVs, storage classes)
```

## Manifest Descriptions

### AI Workloads (`ai/`)

#### `vllm-amd.yaml`
A deployment manifest for running vLLM (a fast LLM inference engine) on AMD GPU hardware. The manifest includes:
- **Deployment**: Runs the `rocm/vllm` container with ROCm support for AMD GPUs (MI300 series). Configured with host network and IPC access for optimal tensor parallel inference performance.
- **Shared Memory**: Uses an `emptyDir` with `medium: Memory` to provide sufficient shared memory for vLLM's tensor parallel operations.
- **GPU Resources**: Requests and limits GPU resources via the `amd.com/gpu` resource, along with CPU and memory allocations.
- **Security**: Configured with `seccompProfile: Unconfined` and `SYS_PTRACE` capability for GPU debugging and process tracing.
- **Service**: Exposes a ClusterIP service on port 80, forwarding to the vLLM API on port 8888.
- **Environment**: Retrieves the Hugging Face Hub token from a Kubernetes secret for model access.

#### `vllm-amd-pvc.yaml`
A PersistentVolumeClaim (PVC) manifest for storing vLLM model weights. The claim requests 50Gi of `cc-local-ssd-fast` storage with ReadWriteOnce access mode, suitable for hosting large model files with fast I/O performance.

### Certificate Management (`certs/`)

#### `CertIssuer.yaml`
A namespaced `Issuer` resource for cert-manager that enables TLS certificate issuance for the `default` namespace. It uses Let's Encrypt's ACME protocol with HTTP-01 challenge validation routed through the Gateway API, enabling automatic certificate provisioning for web applications.

#### `ClusterIssuer.yaml`
A cluster-wide `ClusterIssuer` resource for cert-manager that provides TLS certificate issuance across all namespaces. It uses Let's Encrypt's production ACME server (`https://acme-v02.api.letsencrypt.org/directory`) with HTTP-01 challenge validation via the Gateway API. The issuer is configured with the email `[ADMIN_EMAIL]` and uses a TLS server profile for challenge verification.

#### `CertManagerValues.yaml`
A Helm values file that enables Gateway API support for cert-manager. It configures:
- `enableGatewayAPI`: Enables Gateway API integration for certificate provisioning.
- `enableGatewayAPIListenerSet`: Enables ListenerSet feature for advanced listener management.
- `featureGates.ListenerSets`: Enables the ListenerSets feature gate for experimental functionality.

#### `test-resources.yaml`
Test resources for validating cert-manager functionality. It includes:
- A `Namespace` named `cert-manager-test`.
- A self-signed `Issuer` for testing purposes.
- A `Certificate` resource that creates a self-signed TLS certificate for `example.com`, storing the resulting TLS secret as `selfsigned-cert-tls`.

### Custom Resource Definitions (`crd/`)

#### `sites.crd.yaml`
A Custom Resource Definition for the `sites` resource. This CRD enables management of multi-site configurations within the Community Cloud, allowing users to define and configure site-specific settings declaratively.

#### `webapps.crd.yaml`
A Custom Resource Definition for the `webapps` resource that provides comprehensive web application lifecycle management. When a `Webapp` custom resource is created, the associated controller orchestrates:
- **Deployment**: Configurable webapp image, replica count, and container settings (ports, environment variables).
- **Storage**: Persistent volume claims with configurable size and mount paths.
- **Resource Management**: CPU and memory limits and requests with sensible defaults.
- **Database Integration**: Built-in support for database clusters (e.g., CloudNative-PG) with configurable storage and cluster references.
- **Networking**: Domain name management, ingress/egress routing, and Gateway API HTTPRoute configuration.
- **Framework-Specific Handling**: Automatic handling of framework-specific considerations and dependencies.

The CRD is scoped to namespaces and supports short aliases (`wa`) for convenient CLI usage.

### Database (`database/`)

#### `PostGISCluster.yaml`
A CloudNative-PG `Cluster` manifest for deploying a PostGIS-enabled PostgreSQL database. Key configurations include:
- **Image**: Uses `ghcr.io/cloudnative-pg/postgis:18-3.6-system-trixie`, providing PostgreSQL 18 with PostGIS 3.6 extensions.
- **Instances**: Deployed as a single-instance cluster (can be scaled for high availability).
- **Storage**: 30Gi persistent storage using the `cc-local-ssd-fast` storage class.
- **Logging**: Configured to log DDL statements (`log_statement: ddl`) for auditing and debugging.
- **Bootstrap**: Uses the CloudNative-PG initdb bootstrap method with import capability for existing data migrations.
- **Extensions**: Includes commented configuration for creating a PostGIS-enabled database with the `postgis` extension.

### Gateway (`gateway/`)

#### `Gateway.yaml`
A Gateway API resource for the main domain. It configures:
- **HTTP Listener**: Port 8000 for HTTP traffic.
- **HTTPS Listener**: Port 8443 with TLS termination using the `cc-hq-secret` certificate.
- **Gateway Class**: Uses the Traefik gateway class for traffic management.
- **Hostname**: Configured for the main domain with automatic certificate provisioning via cert-manager.

#### `GatewayClass.yaml`
A GatewayClass resource that defines the `cc-gateway-class` with the controller name `traefik.io/gateway-controller`. This class specifies that Traefik will manage all Gateways associated with this class, providing a standardized gateway infrastructure across the cluster.

#### `NginxFabricValues.yaml`
A Helm values file for configuring Nginx Ingress Controller deployments. It includes node affinity rules that ensure Nginx pods are scheduled only on nodes with the `gateway` role (`node-role.kubernetes.io/gateway: gateway`), providing dedicated gateway infrastructure.

### K3s Configuration (`k3s-config/`)

#### `README.md`
Documentation for K3s-specific configurations within the Community Cloud deployment.

#### `registries.yaml`
A K3s registry configuration file that defines authentication credentials for private container registries. It includes:
- **Registry**: `registry.gitlab.com` for GitLab Container Registry.
- **Authentication**: Configured with username `community-cloud-prime` and a stored password for accessing private container images.

### Storage (`storage/`)

#### `GarageValues.yaml`
A Helm values file for deploying Garage (a distributed object storage system) as a StatefulSet. Key configurations include:
- **Replication**: Default replication factor of 1 (configurable for production).
- **Persistence**: Separate meta (300Mi) and data (200Gi) storage using the `cc-local-ssd-fast` storage class.
- **Service**: NodePort service exposing S3 API (port 3900) and web interface (port 3902).
- **Scheduling**: Node selector restricts Garage pods to nodes with the `storage-local` role.
- **Monitoring**: Optional Prometheus metrics and service monitor integration.

#### `LongshenPV.yml`
A PersistentVolume manifest for the `longshen` node. It defines a 900Gi volume mounted from `/better-futures` on the host, with `ReadWriteOnce` access mode and `standard` storage class. Node affinity ensures the volume is only bound to the `longshen` node.

#### `SsdFastStorageClass.yaml`
A StorageClass resource named `cc-local-ssd-fast` that serves as the default storage class for the cluster. It is provisioned by TopoLVM and configured with:
- **Filesystem**: XFS format for optimal performance.
- **Device Class**: SSD device class for high-speed storage.
- **Provisioner**: `topolvm.io` for TopoLVM-based volume provisioning.
- **Reclaim Policy**: `Retain` to prevent accidental data loss from unused volumes.
- **Volume Expansion**: Enabled for dynamic storage growth.
- **Binding Mode**: `WaitForFirstConsumer` for optimal scheduling with TopoLVM.

#### `TopoLVM-defaultValues.yaml`
The default Helm values file for the TopoLVM Helm chart. It provides comprehensive configuration options for deploying TopoLVM across the cluster, including:
- **Image Configuration**: Uses the `ghcr.io/topolvm/topolvm-with-sidecar` image.
- **CSI Components**: Configures CSI provisioner, resizer, snapshotter, and node registrar.
- **Scheduler**: Optional scheduler deployment with control-plane affinity.
- **LVMD**: Managed lvmd daemon with device class configuration (SSD, SATA, HDD).
- **Node Component**: Embedded lvmd with kubelet integration for volume management.
- **Controller**: Leader election, storage capacity tracking, and PDB support.
- **Storage Classes**: Default TopoLVM storage class with XFS filesystem, Retain reclaim policy, and volume expansion support.
- **Webhook**: cert-manager integration for TLS certificate management.
- **Monitoring**: Prometheus PodMonitor integration for metrics collection.

#### `TopoLVMValues.yaml`
A customized Helm values file for deploying TopoLVM in the Community Cloud environment. It configures:
- **Controller**: Scheduled on nodes with the `storage-local` role.
- **LVMD**: Managed mode enabled with three device classes:
  - `ssd`: Uses `cc-ssd-vg` volume group (default).
  - `ssd-sata`: Uses `cc-ssd-sata-vg` volume group.
  - `hdd`: Uses `cc-hdd-vg` volume group.
- **Node**: Scheduled on nodes with the `storage-local` role.

## Deployment Notes

### Storage Architecture
The Community Cloud uses TopoLVM as its primary storage provisioner, leveraging local block devices across nodes for high-performance storage. The default storage class (`cc-local-ssd-fast`) provides fast SSD storage for most workloads, while alternative storage classes are available for specialized use cases.

### Certificate Management
All TLS certificates are managed by cert-manager using Let's Encrypt as the CA. HTTP-01 challenges are routed through the Gateway API, enabling automatic certificate provisioning and renewal for all gateway endpoints.

### Gateway Infrastructure
Traffic is managed by Traefik via the Kubernetes Gateway API, with dedicated gateway nodes ensuring consistent performance and isolation. Multiple domain are supported through separate Gateway resources.

### AI Workload Support
The manifests include support for GPU-accelerated AI inference using vLLM on AMD GPU hardware (MI300 series). The deployment is configured for optimal tensor parallel performance with host network access, shared memory allocation, and appropriate GPU resource requests.
