/**
 * @file
 * Everything Meteorologist asks of the Kubernetes API, as one
 * interface.
 *
 * The pages and actions only ever see this. Behind it is either the
 * real API server, reached as whoever is signed in, or an in-memory
 * cluster for development; and if the way the API is reached changes —
 * a different client library, a service account with impersonation in
 * place of forwarded tokens — it changes behind here and nowhere else.
 *
 * Errors come out as KubeError whichever is behind it, carrying the
 * HTTP status the API server gave, so a page can tell "you may not"
 * from "there's no such thing" without knowing about either client.
 */
import type { Namespace } from "./types";
import type { WebApplication } from "../webapp/types";

/**
 * The calls this app makes.
 */
export interface KubeClient {
  /**
   * Every namespace the person may list.
   *
   * @returns
   */
  listNamespaces(): Promise<Namespace[]>;

  /**
   * One namespace.
   *
   * @param name
   * @returns
   */
  getNamespace(name: string): Promise<Namespace>;

  /**
   * Sets or removes labels on a namespace, with a JSON merge patch. A
   * null removes the label.
   *
   * @param name
   * @param labels
   * @returns the namespace as it is afterwards
   */
  patchNamespaceLabels(name: string, labels: Record<string, string | null>): Promise<Namespace>;

  /**
   * WebApplications, in one namespace or in all of them.
   *
   * @param namespace
   * @returns
   */
  listWebApplications(namespace?: string): Promise<WebApplication[]>;

  /**
   * One WebApplication.
   *
   * @param namespace
   * @param name
   * @returns
   */
  getWebApplication(namespace: string, name: string): Promise<WebApplication>;

  /**
   * Makes a new WebApplication.
   *
   * @param app
   * @returns
   */
  createWebApplication(app: WebApplication): Promise<WebApplication>;

  /**
   * Replaces a WebApplication's spec. The resourceVersion it carries
   * makes this fail with a conflict if it changed in the meantime.
   *
   * @param app
   * @returns
   */
  replaceWebApplication(app: WebApplication): Promise<WebApplication>;

  /**
   * Makes an Opaque Secret from plain strings.
   *
   * @param namespace
   * @param name
   * @param data
   * @param labels
   */
  createSecret(
    namespace: string,
    name: string,
    data: Record<string, string>,
    labels?: Record<string, string>,
  ): Promise<void>;
}

/**
 * Something the API server refused, or couldn't be asked.
 *
 * - status: the HTTP status, or 0 when the API server couldn't be
 *   reached at all
 * - reason: the API server's reason, such as "Forbidden" or "Conflict"
 */
export class KubeError extends Error {
  readonly status: number;
  readonly reason?: string;

  constructor(status: number, message: string, reason?: string) {
    super(message);
    this.name = "KubeError";
    this.status = status;
    this.reason = reason;
  }
}

/**
 * Whether an error is the API server saying there's no such thing.
 *
 * @param error
 * @returns
 */
export function isNotFound(error: unknown): boolean {
  return error instanceof KubeError && error.status === 404;
}

/**
 * Whether an error is RBAC refusing the person.
 *
 * @param error
 * @returns
 */
export function isForbidden(error: unknown): boolean {
  return error instanceof KubeError && error.status === 403;
}

/**
 * A sentence a person can read, from any error the client threw.
 *
 * @param error
 * @returns
 */
export function describeError(error: unknown): string {
  if (error instanceof KubeError) {
    switch (error.status) {
      case 0:
        return `The Kubernetes API couldn't be reached: ${error.message}`;
      case 401:
        return "The Kubernetes API didn't accept your sign-in. Signing out and in again usually fixes it.";
      case 403:
        return `You don't have permission for that. ${error.message}`;
      case 409:
        return error.reason === "AlreadyExists"
          ? `That already exists. ${error.message}`
          : "Someone else changed this while you were editing it. Reload to see their change, then try again.";
      default:
        return error.message;
    }
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * A read that either worked or didn't, so a page can draw what it got
 * and say what it didn't, rather than failing whole.
 */
export type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

/**
 * Runs a read, catching its failure.
 *
 * @param read
 * @returns
 */
export async function settle<T>(read: () => Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await read() };
  } catch (error) {
    return { ok: false, error };
  }
}
