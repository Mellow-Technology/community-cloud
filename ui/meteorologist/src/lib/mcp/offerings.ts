/**
 * @file
 * Offerings an agent makes for Services that aren't applications of its
 * own: something deployed in the namespace some other way, such as a
 * model server or a database, which applications here should be able
 * to connect to by name.
 *
 * An application offers itself through its own offers field instead,
 * and that offering, owned by the application, is changed only through
 * it. What an agent may set here is what describes and reaches the
 * Service: its title, description, protocol, Service and port, path,
 * and plain values. Two things are a person's, in Meteorologist, and
 * are refused rather than set:
 *
 * - shareWith, which opens it to other namespaces, a trust decision
 * - secret, which hands a Secret's keys to every connection
 *
 * There's no deleting one from here either: whatever connects to it
 * would stop working.
 *
 * Changes are laid over the offering as it is, field by field, and
 * written back over it, so what an agent doesn't mention, a person's
 * shareWith and secret included, stays as it was.
 */
import { envPrefix } from "../webapp/form";
import { PROTOCOLS, type Protocol, type ServiceOffering } from "../offerings/types";
import { API_VERSION } from "../webapp/types";

/**
 * What an agent may set on an offering. In an update, a field left
 * out is left as it is.
 */
export interface OfferingChanges {
  title?: string;
  description?: string;
  protocol?: string;
  service?: { name: string; port?: string | number };
  // null removes it
  path?: string | null;
  // A value sets one; null removes it
  values?: Record<string, string | null>;
}

// The fields an agent may give, so anything else is refused by name
export const OFFERING_FIELDS = ["title", "description", "protocol", "service", "path", "values"] as const;

// What the binding has already and a value can't replace (Cirrus's
// RESERVED_ENTRIES, operators/cirrus/src/offerings/mod.rs)
const RESERVED = ["type", "provider", "host", "port", "uri"];

// A Kubernetes name of one DNS label, as Services and offerings are
const NAME = /^[a-z]([-a-z0-9]*[a-z0-9])?$/;
// A Service's port by name, or a number
const PORT = /^([a-z0-9]([-a-z0-9]*[a-z0-9])?|\d{1,5})$/;
// A value's key: it becomes part of a variable's name
const VALUE_KEY = /^[A-Za-z][A-Za-z0-9_-]*$/;

/**
 * What's wrong with a name for an offering, or nothing.
 *
 * @param name
 * @returns
 */
export function offeringNameProblem(name: string): string | undefined {
  return name.length > 63 || !NAME.test(name)
    ? "An offering's name: lower-case letters, digits and hyphens, starting with a letter."
    : undefined;
}

/**
 * The offering with the changes laid over it, and what's wrong.
 *
 * @param base the offering as it is, or nothing for a new one
 * @param namespace
 * @param name
 * @param changes
 * @returns the offering to write, and a sentence for each problem;
 *   empty when it can be written
 */
export function applyOfferingChanges(
  base: ServiceOffering | undefined,
  namespace: string,
  name: string,
  changes: OfferingChanges,
): { offering: ServiceOffering; problems: string[] } {
  const problems: string[] = [];
  const offering: ServiceOffering = base
    ? structuredClone(base)
    : {
        apiVersion: API_VERSION,
        kind: "ServiceOffering",
        metadata: { name, namespace },
        spec: { title: "", service: { name: "" } },
      };
  const spec = offering.spec;

  if (base === undefined) {
    const problem = offeringNameProblem(name);
    if (problem !== undefined) problems.push(`name: ${problem}`);
  }

  if (changes.title !== undefined) spec.title = changes.title.trim();
  if (changes.description !== undefined) {
    const description = changes.description.trim();
    if (description === "") delete spec.description;
    else spec.description = description;
  }
  if (changes.protocol !== undefined) {
    if ((PROTOCOLS as readonly string[]).includes(changes.protocol)) {
      spec.protocol = changes.protocol as Protocol;
    } else {
      problems.push(`protocol: one of ${PROTOCOLS.join(", ")}.`);
    }
  }
  if (changes.service !== undefined) {
    const serviceName = changes.service.name.trim();
    const port = changes.service.port === undefined ? undefined : String(changes.service.port).trim();
    if (!NAME.test(serviceName)) {
      problems.push("service.name: the name of a Service in this namespace.");
    }
    if (port !== undefined && port !== "" && !PORT.test(port)) {
      problems.push("service.port: one of the Service's ports, by name or number.");
    }
    spec.service = { name: serviceName, ...(port ? { port } : {}) };
  }
  if (changes.path !== undefined) {
    if (changes.path === null || changes.path.trim() === "") {
      delete spec.path;
    } else if (!changes.path.trim().startsWith("/")) {
      problems.push("path: a path, starting with /.");
    } else {
      spec.path = changes.path.trim();
    }
  }
  for (const [key, value] of Object.entries(changes.values ?? {})) {
    if (!VALUE_KEY.test(key)) {
      problems.push(`values.${key}: a value's name is letters, digits, - and _, starting with a letter.`);
      continue;
    }
    if (RESERVED.includes(key.toLowerCase())) {
      problems.push(`values.${key}: ${key} is already in every connection, and can't be replaced.`);
      continue;
    }
    const values = { ...spec.values };
    if (value === null) delete values[key];
    else values[key] = value;
    if (Object.keys(values).length > 0) spec.values = values;
    else delete spec.values;
  }

  if (spec.title === "") problems.push("title: say what it is, in a few words.");
  if (spec.service.name === "") problems.push("service: the Service in this namespace it's for.");
  return { offering, problems };
}

/**
 * The application an offering belongs to, when it's one's own.
 *
 * @param offering
 * @returns
 */
export function owningApplication(offering: ServiceOffering): string | undefined {
  return offering.metadata.ownerReferences?.find((owner) => owner.kind === "WebApplication")?.name;
}

/**
 * An offering as an agent is shown it: what it is, what connecting
 * gives, whether it's ready, and who's connected. A Secret's name is
 * shown, never what's in it.
 *
 * @param offering
 * @returns
 */
export function describeOffering(offering: ServiceOffering): Record<string, unknown> {
  const spec = offering.spec;
  const ready = offering.status?.conditions?.find((condition) => condition.type === "Ready");
  const prefix = envPrefix(offering.metadata.name);
  return {
    name: offering.metadata.name,
    namespace: offering.metadata.namespace,
    title: spec.title,
    description: spec.description,
    protocol: spec.protocol ?? "http",
    service: spec.service,
    path: spec.path,
    values: spec.values ?? {},
    // A person's to set; shown so an agent knows who else can connect
    shareWith: spec.shareWith ?? [],
    secret: spec.secret,
    ownedBy: owningApplication(offering),
    ready: ready?.status === "True",
    readyMessage: ready?.status === "True" ? undefined : ready?.message || ready?.reason,
    url: offering.status?.uri,
    // What a connection to it with no name of its own is given
    variables: [
      `${prefix}_HOST`,
      `${prefix}_PORT`,
      `${prefix}_URL`,
      `${prefix}_TYPE`,
      ...Object.keys(spec.values ?? {}).map((key) => `${prefix}_${envPrefix(key)}`),
    ],
    consumers: offering.status?.consumers ?? [],
  };
}
