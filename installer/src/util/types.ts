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

export type K3sRegistry = {
  auth: {
    username: string;
    password: string;
  };
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
  address: string;
  username: string;
  keyFile: string;
  type: K3SInstallationType;
  gateway: boolean;
  labels: NodeRole[];
  useTailscale: boolean;
}
