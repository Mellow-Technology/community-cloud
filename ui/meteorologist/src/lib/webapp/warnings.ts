/**
 * @file
 * Which of an application's choices its namespace doesn't allow.
 *
 * A WebApplication asking for a hostname or a bucket in a namespace
 * without the matching label is accepted by the API server without
 * complaint. Cirrus then finds it can't do what was asked and says so
 * in a condition, and the person who asked finds out some minutes
 * later, if they think to look. Saying so in the form, while the
 * label can still be put on, saves that round trip.
 *
 * These are warnings rather than errors: the label can be added after
 * the application is saved, and Cirrus will pick it up when it is.
 */
import { getCapability, hasCapability, type Capability } from "../capabilities";
import { POSTGRES_CLUSTER, POSTGRES_STORAGE, postgresStorageProblem } from "../postgres";
import type { WebApplicationForm } from "./form";

/**
 * A capability the form needs and the namespace doesn't have.
 *
 * - capability: the label that would fix it
 * - field: the part of the form that needs it, so the warning can sit
 *   beside it
 * - message: what will go wrong without it
 */
export interface CapabilityWarning {
  capability: Capability;
  field: keyof WebApplicationForm;
  message: string;
}

/**
 * Which capabilities the form's choices depend on, whatever the
 * namespace has.
 *
 * @param form
 * @returns
 */
export function requiredCapabilities(form: WebApplicationForm): CapabilityWarning[] {
  const required: CapabilityWarning[] = [];

  if (form.hostnames.some((hostname) => hostname.trim() !== "")) {
    required.push({
      capability: getCapability("gateway"),
      field: "hostnames",
      message:
        "The cluster Gateway won't accept this application's hostnames from this namespace, so it won't be " +
        "reachable from outside the cluster.",
    });
  }

  if (form.bucket) {
    required.push({
      capability: getCapability("buckets"),
      field: "bucket",
      message: "SeaweedFS won't make a bucket for this namespace, so Cirrus will report the application as blocked.",
    });
  }

  return required;
}

/**
 * The capabilities the form needs that the namespace lacks.
 *
 * @param form
 * @param labels the namespace's labels; missing when the namespace
 *   couldn't be read, in which case nothing is said rather than a
 *   warning that may be wrong
 * @returns
 */
export function capabilityWarnings(
  form: WebApplicationForm,
  labels: Record<string, string> | undefined,
): CapabilityWarning[] {
  if (labels === undefined) {
    return [];
  }
  return requiredCapabilities(form).filter((warning) => !hasCapability(labels, warning.capability));
}

/**
 * What asking for a database means in a namespace: sharing the
 * Postgres already there, or starting one — and whether its quota
 * leaves room to.
 *
 * @param namespace what's known about the namespace
 * @returns nothing when whether it has a Postgres couldn't be found out
 */
export function postgresNote(namespace: {
  name: string;
  hasPostgres?: boolean;
  storageQuota?: string;
  storageUsed?: string;
}): { tone: "neutral" | "warning"; message: string } | undefined {
  if (namespace.hasPostgres === undefined) {
    return undefined;
  }
  if (namespace.hasPostgres) {
    return { tone: "neutral", message: `It joins the other databases in ${namespace.name}'s ${POSTGRES_CLUSTER}.` };
  }
  const problem = postgresStorageProblem(namespace.storageQuota, namespace.storageUsed);
  if (problem !== undefined) {
    return { tone: "warning", message: problem };
  }
  return {
    tone: "neutral",
    message:
      `${namespace.name} has no Postgres yet, so this starts one: ${POSTGRES_CLUSTER}, with a ${POSTGRES_STORAGE} ` +
      "volume, shared by every application here that asks for a database after it. It stays if the applications go.",
  };
}
