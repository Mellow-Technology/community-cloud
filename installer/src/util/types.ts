/**
 * The type of K3s installation
 * - Server:
 *   The control server of the K3s installation
 * - Agent:
 *   An agent installation of K3s.
 */
export enum K3SInstallationType {
  Server = "server",
  Agent = "agent",
}

/**
 * Credentials for a registry.
 *
 * Either a username and password, or one of the pre-encoded forms
 * containerd accepts: "auth" is base64 of "username:password", and an
 * identity token is what some registries hand out instead.
 */
export interface K3sRegistryAuth {
  username?: string;
  password?: string;
  auth?: string;
  identityToken?: string;
}

/**
 * TLS settings for talking to a registry, for the ones using a private
 * certificate authority or a client certificate.
 */
export interface K3sRegistryTls {
  caFile?: string;
  certFile?: string;
  keyFile?: string;
  insecureSkipVerify?: boolean;
}

export type K3sRegistry = {
  auth?: K3sRegistryAuth;
  tls?: K3sRegistryTls;

  // Where to actually fetch from, when that isn't the registry's own
  // name. Only needed for mirroring, or for a registry whose name
  // isn't the host serving it, as with docker.io.
  endpoint?: string[];

  // Regular expression rewrites applied to the image path
  rewrite?: Record<string, string>;
};

// A set of container registries
// which K3S can pull from
export interface K3SRegistriesConfiguration {
  [key: string]: K3sRegistry;
}

/**
 * We classify nodes into roles for how they will be used.
 * Nodes can have multiple roles, though it's suggested
 * that roles be as limited as possible to prevent noisy neighbor
 * and contention issues.
 *
 * The roles are:
 * - Gateway:
 *   The node can serve as a publicly routeable gateway to the cluster.
 *   Any gateway nodes should have a publicly routable and ideally stable
 *   IP address.
 * - Lighthouse:
 *   A lighthouse node is used for networking purposes so that hosts can find
 *   each other even when split across various networks or located behind NAT
 *   or firewalls. Depending on the network type a lighthouse isn't necessarily
 *   needed. Currently this role is unused.
 * - Worker:
 *   A worker node is one which can be used for any general purpose workload.
 *   It's expected that a worker node can take on any general computing task.
 * - Worker GPU:
 *   Another type of worker node, but Worker GPU nodes are also equipped with
 *   GPU based compute.
 * - Storage Local:
 *   A storage local node is one that has persistent storage available that's
 *   addressed locally. i.e. if a pod needs to access data on this node it
 *   also needs to run on this node. This type would be used for most databases
 *   including distributed databases as they will typically be in charge of
 *   their own data replication.
 * - Storage Distributed:
 *   A storage distributed node is one that can be used to take part in a distributed
 *   storage pool of some kind such as S3 or an external managed object store.
 *
 */
export enum NodeRole {
  Gateway = "gateway",
  Lighthouse = "lighthouse",
  Worker = "worker",
  WorkerGPU = "worker-gpu",
  StorageLocal = "storage-local",
  StorageDistributed = "storage-distributed",
}

/**
 * Who made a piece of video hardware.
 *
 * Worked out from the PCI vendor ID rather than from a name, since the
 * names vary and the IDs don't. The last few matter because servers
 * nearly always have video hardware that is no use for compute: a BMC
 * puts an ASPEED or Matrox chip on the bus, and a virtual machine gets
 * an emulated adapter. Both are display hardware, neither is something
 * to install a GPU runtime for.
 */
export enum GpuVendor {
  Nvidia = "nvidia",
  Amd = "amd",
  Intel = "intel",

  // Onboard server video, from the management controller
  Aspeed = "aspeed",
  Matrox = "matrox",

  // Emulated adapters
  Virtio = "virtio",
  Vmware = "vmware",
  Qemu = "qemu",
  Hyperv = "hyperv",

  // Found something, but nothing we know what to do with
  Unknown = "unknown",
}

/**
 * A single piece of video hardware on a node.
 */
export interface VideoDevice {
  // Where it sits. A PCI address like "0000:01:00.0", or the DRM card
  // name for hardware that isn't on a PCI bus at all, which is how the
  // GPU on an ARM board shows up.
  address: string;

  vendor: GpuVendor;

  // Whether this is worth installing a GPU runtime for, or is only
  // ever going to draw a console
  compute: boolean;

  // Straight off the PCI bus, when it's a PCI device
  vendorId?: string;
  deviceId?: string;
  deviceClass?: string;

  // The kernel driver bound to it, e.g. "nvidia", "amdgpu", "i915"
  driver?: string;

  // A readable name, which needs lspci and its device database
  model?: string;

  // Filled in by whichever vendor command knows how to ask
  memoryBytes?: number;
  driverVersion?: string;
  computeCapability?: string;
  cores?: number;
  maxFrequencyMhz?: number;
  uuid?: string;
}

export interface GpuInfo {
  type: "nvidia" | "amd" | "intel" | "none";
  model?: string;
  count?: number; // for NVIDIA (multiple GPUs)
  driversInstalled?: boolean;
}

/**
 * Node specification
 */
export interface NodeSpecification {
  name: string;

  // How to reach the node over SSH. Often an alias from ~/.ssh/config
  // rather than anything DNS knows about.
  address: string;

  // Where other nodes reach this one's Kubernetes API, when that isn't
  // the same as the address we administer it through. An SSH alias, a
  // bastion or a port forward all get you to a node without being a
  // name the rest of the cluster can use.
  apiAddress?: string;

  username: string;
  keyFile: string;
  port?: number;
  type: K3SInstallationType;
  gateway: boolean;
  labels: NodeRole[];
  useTailscale: boolean;
}
