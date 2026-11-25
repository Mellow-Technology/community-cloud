/**
 * @file
 * Cirrus's ServiceOffering (community-cloud.technology/v1alpha1): a
 * service saying what it is and how to reach it, so applications can
 * connect to it by name. See operators/cirrus/README.md, "Connecting to
 * services".
 */
import type { Condition, ObjectMeta } from "../kube/types";

export const OFFERING_PLURAL = "serviceofferings";

export const PROTOCOLS = ["http", "https", "grpc", "postgres", "mysql", "redis", "amqp", "tcp"] as const;
export type Protocol = (typeof PROTOCOLS)[number];

export interface ServiceOffering {
  apiVersion?: string;
  kind?: string;
  metadata: ObjectMeta & { ownerReferences?: Array<{ kind: string; name: string }> };
  spec: {
    title: string;
    description?: string;
    protocol?: Protocol;
    service: { name: string; port?: string };
    path?: string;
    shareWith?: string[];
    secret?: string;
    values?: Record<string, string>;
  };
  status?: {
    conditions?: Condition[];
    host?: string;
    port?: number;
    uri?: string;
    binding?: { name: string };
    consumers?: Array<{ namespace: string; name: string; allowed: boolean }>;
  };
}
