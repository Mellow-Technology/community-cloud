/**
 * @file
 * What Cirrus can give applications in a namespace, as it reports it,
 * and what that means for the MCP tools.
 *
 * Cirrus keeps it in each namespace's cirrus-capabilities ConfigMap
 * (operators/cirrus/src/capabilities), which an agent's token may read
 * and nothing else besides its applications. The tools use it three
 * ways:
 *
 * - get_capabilities hands it over, for an agent to plan with and to
 *   tell a person what to ask for
 * - tools/list leaves out of create and update what isn't available,
 *   so an agent isn't offered a database the cluster can't make
 * - create and update refuse what isn't available, with Cirrus's
 *   reason, rather than leave a rollout stuck in Provisioned: False
 *
 * Where there's no report (a Cirrus from before it wrote one, or one
 * that hasn't got to the namespace yet), nothing is held back: Cirrus
 * says what's wrong when it provisions, as it always has.
 */
import { isForbidden, type KubeClient } from "../kube/client";
import type { ApplicationChanges } from "./changes";

export const CAPABILITIES_CONFIG_MAP = "cirrus-capabilities";
export const CAPABILITIES_KEY = "capabilities.json";

export interface Availability {
  available: boolean;
  reason?: string;
}

/**
 * The report, as operators/cirrus/src/capabilities/mod.rs writes it.
 */
export interface Capabilities {
  version: number;
  namespace: string;
  services: { postgres: Availability; rabbitmq: Availability; bucket: Availability };
  storage: Array<{ type: string; storageClass?: string; available: boolean }>;
  ingress: Availability;
  egress: { restricted: boolean; policies?: string[]; clusterPolicies?: string[] };
  offerings: Array<{
    name: string;
    namespace: string;
    title: string;
    description?: string;
    protocol: string;
    ready: boolean;
  }>;
}

export const SERVICES = ["postgres", "rabbitmq", "bucket"] as const;

/**
 * The namespace's report, or nothing when there isn't one to read.
 *
 * @param kube
 * @param namespace
 * @returns
 */
export async function readCapabilities(
  kube: Pick<KubeClient, "getConfigMap">,
  namespace: string,
): Promise<Capabilities | undefined> {
  try {
    const configMap = await kube.getConfigMap(namespace, CAPABILITIES_CONFIG_MAP);
    const text = configMap?.data?.[CAPABILITIES_KEY];
    if (text === undefined) return undefined;
    const parsed = JSON.parse(text) as Capabilities;
    return typeof parsed === "object" && parsed !== null && parsed.services !== undefined ? parsed : undefined;
  } catch (error) {
    // An older Cirrus's roles don't grant reading it, and a report
    // that isn't JSON is no report
    if (isForbidden(error) || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

/**
 * What a change asks for that the namespace can't have, each with why.
 * Only what it adds counts: a database an application already has
 * isn't asked for again.
 *
 * @param changes
 * @param capabilities nothing when there's no report, which allows all
 * @param has what the application already has
 * @param has.services
 * @param has.connections the offerings it's connected to, as
 *   namespace/name
 * @returns
 */
export function unavailable(
  changes: ApplicationChanges,
  capabilities: Capabilities | undefined,
  has: { services: ReadonlySet<string>; connections: ReadonlySet<string> },
): string[] {
  if (capabilities === undefined) return [];
  const problems: string[] = [];

  for (const service of SERVICES) {
    const asked = changes[service] === true || (service === "bucket" && typeof changes.bucket === "object");
    const availability = capabilities.services[service];
    if (asked && !has.services.has(service) && !availability.available) {
      problems.push(`${service} isn't available here: ${availability.reason ?? "Cirrus says it can't provide one."}`);
    }
  }

  for (const volume of changes.volumes ?? []) {
    const type = volume.type ?? "fast";
    const storage = capabilities.storage.find((each) => each.type === type);
    if (storage !== undefined && !storage.available) {
      const others = capabilities.storage.filter((each) => each.available).map((each) => each.type);
      problems.push(
        `The volume ${volume.name} can't be ${type}: this cluster has no ${storage.storageClass ?? type} StorageClass. Use ${others.join(", ") || "another type"}.`,
      );
    }
  }

  for (const connection of changes.connections ?? []) {
    const namespace = connection.namespace ?? capabilities.namespace;
    const id = `${namespace}/${connection.offering}`;
    const offered = capabilities.offerings.some(
      (offering) => offering.name === connection.offering && offering.namespace === namespace,
    );
    if (!offered && !has.connections.has(id)) {
      problems.push(`${id} isn't offered to this namespace. get_capabilities lists what is.`);
    }
  }

  return problems;
}

/**
 * The create and update tools' fields with what isn't available taken
 * out: a service that can't be had, and storage types without their
 * StorageClass. The schema given is left alone.
 *
 * @param properties
 * @param capabilities nothing when there's no report, which leaves
 *   them as they are
 * @returns
 */
export function availableProperties(
  properties: Record<string, unknown>,
  capabilities: Capabilities | undefined,
): Record<string, unknown> {
  if (capabilities === undefined) return properties;
  const trimmed = structuredClone(properties) as Record<string, Record<string, unknown>>;
  for (const service of SERVICES) {
    if (!capabilities.services[service].available) delete trimmed[service];
  }
  const types = capabilities.storage.filter((each) => each.available).map((each) => each.type);
  const volumeType = (trimmed.volumes?.items as { properties?: Record<string, { enum?: string[] }> } | undefined)
    ?.properties?.type;
  if (volumeType !== undefined) volumeType.enum = types;
  if (trimmed.connections !== undefined) {
    const offered = capabilities.offerings.map((offering) =>
      offering.namespace === capabilities.namespace
        ? offering.name
        : `${offering.name} (namespace ${offering.namespace})`,
    );
    trimmed.connections.description = `${String(trimmed.connections.description)} Offered here: ${offered.join(", ") || "none"}.`;
  }
  return trimmed;
}
