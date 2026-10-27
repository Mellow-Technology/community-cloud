/**
 * @file
 * A namespace's settings, as a form, and the resources they become.
 *
 * Three things are set for a namespace as a whole, each the way
 * Kubernetes itself does it, so they hold for everything in it — what
 * Cirrus makes, CloudNativePG's Postgres, and anything applied by hand:
 *
 * - How much it may use in total: a ResourceQuota. CPU is capped by
 *   what's reserved (requests) rather than by limits, so applications
 *   aren't throttled to stay under it; memory by limits, since memory
 *   can't be taken back once used. Storage covers every volume,
 *   Postgres's included.
 * - What each container gets when it doesn't say: a LimitRange. A
 *   quota on CPU or memory makes Kubernetes refuse any pod that
 *   doesn't state them, and plenty don't — CloudNativePG's Postgres,
 *   for one — so a quota needs these defaults to be usable.
 * - Which registries it can pull private images from: Secrets, named
 *   on the namespace's default ServiceAccount, which Kubernetes adds
 *   to every pod that runs as it and doesn't name its own.
 *
 * And, optionally, the region it runs in, the same annotation the
 * installer's "placement" sets (installer/src/util/placement.ts).
 *
 * The quota and the LimitRange are one of each, under one name, so
 * Meteorologist only ever changes its own and leaves any others a
 * person has made alone.
 */
import { CAPABILITIES, capabilityLabelPatch } from "../capabilities";
import type { LimitRange, ResourceQuota, ServiceAccount } from "../kube/types";
import { QUANTITY, parseQuantity } from "../quantity";

// The ResourceQuota and LimitRange Meteorologist manages
export const SETTINGS_NAME = "community-cloud";

// Who made something, for the next person to find
export const CREATED_BY = { "app.kubernetes.io/created-by": "meteorologist" };

// The namespace's ServiceAccount pods run as unless they say otherwise
export const DEFAULT_SERVICE_ACCOUNT = "default";

// What the PodNodeSelector admission plugin reads off a namespace, and
// the node label it's set to select on
export const PLACEMENT_ANNOTATION = "scheduler.alpha.kubernetes.io/node-selector";
export const REGION_LABEL = "topology.kubernetes.io/region";

// The type of Secret Kubernetes reads registry credentials from
export const PULL_SECRET_TYPE = "kubernetes.io/dockerconfigjson";

// A namespace name is an RFC 1123 label
const NAMESPACE_NAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

// Names that already mean something to the cluster
const RESERVED_PREFIXES = ["kube-", "cc-"];

/**
 * Credentials for a private registry, to be made into a pull Secret.
 */
export interface RegistryRow {
  server: string;
  username: string;
  password: string;
}

/**
 * Everything the namespace form edits. Quantities are kept as typed,
 * and empty means "no limit" or "no default".
 */
export interface NamespaceForm {
  name: string;
  // Only when creating; afterwards they're switches of their own
  capabilities: Record<string, boolean>;
  region: string;

  quotaCpu: string;
  quotaMemory: string;
  quotaStorage: string;

  defaultCpuRequest: string;
  defaultCpuLimit: string;
  defaultMemoryRequest: string;
  defaultMemoryLimit: string;

  // Pull Secrets already in the namespace, to keep as defaults
  pullSecrets: string[];
  // New registries, to make pull Secrets for
  registries: RegistryRow[];
}

export type NamespaceFormErrors = Partial<Record<keyof NamespaceForm, string>>;

/**
 * A form for a new namespace. The container defaults are filled in,
 * since a quota is unusable without them, and they're small enough not
 * to matter when there isn't one.
 *
 * @returns
 */
export function emptyNamespaceForm(): NamespaceForm {
  return {
    name: "",
    capabilities: Object.fromEntries(CAPABILITIES.map((capability) => [capability.id, false])),
    region: "",
    quotaCpu: "",
    quotaMemory: "",
    quotaStorage: "",
    defaultCpuRequest: "100m",
    defaultCpuLimit: "",
    defaultMemoryRequest: "128Mi",
    defaultMemoryLimit: "512Mi",
    pullSecrets: [],
    registries: [],
  };
}

/**
 * The region a namespace is placed in, from its annotation.
 *
 * @param annotations
 * @returns the region, or "" when it isn't placed or is placed by
 *   something other than region
 */
export function regionOf(annotations: Record<string, string> | undefined): string {
  const selector = annotations?.[PLACEMENT_ANNOTATION] ?? "";
  const prefix = `${REGION_LABEL}=`;
  return selector.startsWith(prefix) && !selector.includes(",") ? selector.slice(prefix.length) : "";
}

/**
 * The form for an existing namespace, from what's in the cluster.
 *
 * @param name
 * @param annotations
 * @param quota Meteorologist's quota, if there is one
 * @param limitRange Meteorologist's LimitRange, if there is one
 * @param serviceAccount the default ServiceAccount, if it's there yet
 * @returns
 */
export function toNamespaceForm(
  name: string,
  annotations: Record<string, string> | undefined,
  quota: ResourceQuota | undefined,
  limitRange: LimitRange | undefined,
  serviceAccount: ServiceAccount | undefined,
): NamespaceForm {
  const hard = quota?.spec?.hard ?? {};
  const container = limitRange?.spec.limits.find((item) => item.type === "Container");
  return {
    ...emptyNamespaceForm(),
    name,
    region: regionOf(annotations),
    quotaCpu: hard["requests.cpu"] ?? "",
    quotaMemory: hard["limits.memory"] ?? "",
    quotaStorage: hard["requests.storage"] ?? "",
    defaultCpuRequest: container?.defaultRequest?.cpu ?? "",
    defaultCpuLimit: container?.default?.cpu ?? "",
    defaultMemoryRequest: container?.defaultRequest?.memory ?? "",
    defaultMemoryLimit: container?.default?.memory ?? "",
    pullSecrets: (serviceAccount?.imagePullSecrets ?? []).map((secret) => secret.name),
  };
}

/**
 * Only the non-empty entries, trimmed.
 *
 * @param entries
 * @returns
 */
function present(entries: Record<string, string>): Record<string, string> | undefined {
  const kept = Object.entries(entries)
    .map(([key, value]) => [key, value.trim()] as const)
    .filter(([, value]) => value !== "");
  return kept.length > 0 ? Object.fromEntries(kept) : undefined;
}

/**
 * The quota, or undefined when nothing is limited.
 *
 * @param form
 * @returns
 */
export function toResourceQuota(form: NamespaceForm): ResourceQuota | undefined {
  const hard = present({
    "requests.cpu": form.quotaCpu,
    "limits.memory": form.quotaMemory,
    "requests.storage": form.quotaStorage,
  });
  return hard === undefined
    ? undefined
    : {
        metadata: { name: SETTINGS_NAME, namespace: form.name.trim(), labels: CREATED_BY },
        spec: { hard },
      };
}

/**
 * The LimitRange, or undefined when there are no defaults.
 *
 * @param form
 * @returns
 */
export function toLimitRange(form: NamespaceForm): LimitRange | undefined {
  const defaults = present({ cpu: form.defaultCpuLimit, memory: form.defaultMemoryLimit });
  const defaultRequest = present({ cpu: form.defaultCpuRequest, memory: form.defaultMemoryRequest });
  if (defaults === undefined && defaultRequest === undefined) {
    return undefined;
  }
  return {
    metadata: { name: SETTINGS_NAME, namespace: form.name.trim(), labels: CREATED_BY },
    spec: {
      limits: [
        {
          type: "Container",
          ...(defaults !== undefined ? { default: defaults } : {}),
          ...(defaultRequest !== undefined ? { defaultRequest } : {}),
        },
      ],
    },
  };
}

/**
 * The labels a new namespace starts with: what made it, and the
 * capabilities chosen.
 *
 * @param form
 * @returns
 */
export function initialLabels(form: NamespaceForm): Record<string, string> {
  const labels: Record<string, string> = { ...CREATED_BY };
  for (const capability of CAPABILITIES) {
    if (form.capabilities[capability.id]) {
      Object.assign(labels, capabilityLabelPatch(capability, true));
    }
  }
  return labels;
}

/**
 * The annotations part of a merge patch placing the namespace, or
 * un-placing it. Un-placing only removes a selector this form could
 * have set, so one written by hand on some other label survives.
 *
 * @param form
 * @param current the namespace's annotations now
 * @returns
 */
export function placementPatch(
  form: NamespaceForm,
  current: Record<string, string> | undefined,
): Record<string, string | null> {
  const region = form.region.trim();
  if (region !== "") {
    return { [PLACEMENT_ANNOTATION]: `${REGION_LABEL}=${region}` };
  }
  return regionOf(current) !== "" ? { [PLACEMENT_ANNOTATION]: null } : {};
}

/**
 * The Secret name for a registry: its host, made into a name.
 *
 * @param server
 * @returns
 */
export function pullSecretName(server: string): string {
  const host = server
    .trim()
    .replace(/^https?:\/\//, "")
    .split("/")[0]!
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `pull-${host}`.slice(0, 253).replace(/-+$/, "");
}

/**
 * A registry's credentials as the .dockerconfigjson a pull Secret
 * holds.
 *
 * @param registry
 * @returns
 */
export function dockerConfigJson(registry: RegistryRow): string {
  const server = registry.server.trim().replace(/\/+$/, "");
  const username = registry.username.trim();
  // btoa only takes Latin-1, and a password may not be
  const bytes = new TextEncoder().encode(`${username}:${registry.password}`);
  const auth = btoa(String.fromCharCode(...bytes));
  return JSON.stringify({ auths: { [server]: { username, password: registry.password, auth } } });
}

/**
 * Every pull Secret the default ServiceAccount should name: the kept
 * ones, then the new.
 *
 * @param form
 * @returns
 */
export function defaultPullSecrets(form: NamespaceForm): string[] {
  const names = [...form.pullSecrets, ...form.registries.map((registry) => pullSecretName(registry.server))];
  return names.filter((name, index) => name !== "" && names.indexOf(name) === index);
}

/**
 * What's wrong with the form. Empty when nothing is.
 *
 * @param form
 * @param creating whether the namespace is being made, when its name
 *   has to be a good one
 * @returns
 */
export function validateNamespaceForm(form: NamespaceForm, creating: boolean): NamespaceFormErrors {
  const errors: NamespaceFormErrors = {};
  const name = form.name.trim();

  if (creating) {
    if (name === "") {
      errors.name = "Give the namespace a name.";
    } else if (name.length > 63 || !NAMESPACE_NAME.test(name)) {
      errors.name = "Lower-case letters, digits and hyphens, no longer than 63 characters.";
    } else if (RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      errors.name = "Names starting kube- and cc- are the cluster's own.";
    }
  }

  if (form.region.trim() !== "" && !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(form.region.trim())) {
    errors.region = "A region code, such as sea.";
  }

  const quantities = [
    "quotaCpu",
    "quotaMemory",
    "quotaStorage",
    "defaultCpuRequest",
    "defaultCpuLimit",
    "defaultMemoryRequest",
    "defaultMemoryLimit",
  ] as const;
  for (const field of quantities) {
    const value = form[field].trim();
    if (value !== "" && !QUANTITY.test(value)) {
      errors[field] = "A Kubernetes quantity, such as 500m, 2, 512Mi or 20Gi.";
    }
  }

  // A quota on something makes every pod state it; these are what
  // states it for a pod that doesn't
  if (form.quotaCpu.trim() !== "" && form.defaultCpuRequest.trim() === "" && !errors.defaultCpuRequest) {
    errors.defaultCpuRequest = "With a CPU quota, containers need a CPU request, or those without one are refused.";
  }
  if (form.quotaMemory.trim() !== "" && form.defaultMemoryLimit.trim() === "" && !errors.defaultMemoryLimit) {
    errors.defaultMemoryLimit =
      "With a memory quota, containers need a memory limit, or those without one are refused.";
  }

  for (const [request, limit] of [
    ["defaultCpuRequest", "defaultCpuLimit"],
    ["defaultMemoryRequest", "defaultMemoryLimit"],
  ] as const) {
    const low = parseQuantity(form[request]);
    const high = parseQuantity(form[limit]);
    if (low !== undefined && high !== undefined && low > high && !errors[limit]) {
      errors[limit] = "The limit can't be lower than the request.";
    }
  }

  const rows = form.registries;
  if (rows.some((row) => row.server.trim() === "" || row.username.trim() === "" || row.password === "")) {
    errors.registries = "Each registry needs its address, a username and a password or token.";
  } else {
    const names = rows.map((row) => pullSecretName(row.server));
    const repeated = names.find(
      (secret, index) => names.indexOf(secret) !== index || form.pullSecrets.includes(secret),
    );
    if (repeated !== undefined) {
      errors.registries = `There's already a pull Secret called ${repeated}.`;
    }
  }

  return errors;
}
