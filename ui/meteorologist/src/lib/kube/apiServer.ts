/**
 * @file
 * The real Kubernetes API, through @kubernetes/client-node.
 *
 * Where the API server is and which CA vouches for it comes from the
 * pod (the service account mount every pod gets), or, when
 * Meteorologist runs elsewhere, from KUBE_API_SERVER and KUBE_CA_FILE
 * or the cluster a development kubeconfig names.
 * Who the request is made as comes from the caller: the signed-in
 * person's ID token, or, in development, a kubeconfig's user.
 *
 * The pod's own service account token is never used. Meteorologist
 * needs no RBAC of its own, and binding it none means a bug here can't
 * do more than the person using it could have done anyway.
 */
import {
  ApiException,
  CoreV1Api,
  CustomObjectsApi,
  KubeConfig,
  PatchStrategy,
  setHeaderOptions,
  type Cluster,
} from "@kubernetes/client-node";
import "server-only";

import { getApiServerOverride, getDevKubeconfig, hasDevKubeconfig } from "../config";
import { GROUP, PLURAL, VERSION, type WebApplication } from "../webapp/types";
import { KubeError, isNotFound, type KubeClient } from "./client";
import type { LimitRange, Namespace, PostgresCluster, ResourceQuota, SecretSummary, ServiceAccount } from "./types";

// Who server-side applies are made as, so Meteorologist owns only the
// fields it sets
const FIELD_MANAGER = "meteorologist";

// CloudNativePG's Cluster kind
const POSTGRES = { group: "postgresql.cnpg.io", version: "v1", plural: "clusters" };

// The node label a region is read from
const REGION_LABEL = "topology.kubernetes.io/region";

// The name the cluster entry is given inside the KubeConfig built for
// each request. It only has to be the same in both places it's used.
const CLUSTER_NAME = "meteorologist";

let cluster: Cluster | undefined;

/**
 * The API server's address and CA.
 *
 * @returns
 */
function getCluster(): Cluster {
  if (cluster === undefined) {
    const override = getApiServerOverride();
    let found: Cluster;
    if (override.server !== undefined) {
      found = {
        name: CLUSTER_NAME,
        server: override.server,
        caFile: override.caFile,
        skipTLSVerify: override.insecure,
      };
    } else if (hasDevKubeconfig()) {
      // Only the address and CA; the kubeconfig's user isn't used
      const current = configForDevKubeconfig().getCurrentCluster();
      if (current === null) {
        throw new KubeError(0, "METEOROLOGIST_KUBECONFIG has no current cluster.");
      }
      found = { ...current, name: CLUSTER_NAME };
    } else {
      const inCluster = new KubeConfig();
      inCluster.loadFromCluster();
      const current = inCluster.getCurrentCluster();
      if (current === null || !current.server.includes("://") || current.server.includes("undefined")) {
        throw new KubeError(
          0,
          "Not running in a cluster, and KUBE_API_SERVER isn't set, so there's no API server to talk to.",
        );
      }
      found = { ...current, name: CLUSTER_NAME };
    }
    cluster = found;
  }
  return cluster;
}

/**
 * A KubeConfig that makes requests with a bearer token.
 *
 * @param token
 * @returns
 */
function configForToken(token: string): KubeConfig {
  const config = new KubeConfig();
  config.loadFromClusterAndUser(getCluster(), { name: "user", token });
  return config;
}

/**
 * A KubeConfig from the development kubeconfig file.
 *
 * @returns
 */
function configForDevKubeconfig(): KubeConfig {
  const { path, context } = getDevKubeconfig();
  const config = new KubeConfig();
  config.loadFromFile(path);
  if (context !== undefined) {
    config.setCurrentContext(context);
  }
  return config;
}

/**
 * The same failure as a KubeError, with the API server's own message
 * where it gave one.
 *
 * @param error
 * @returns
 */
function translate(error: unknown): KubeError {
  if (error instanceof KubeError) {
    return error;
  }
  if (error instanceof ApiException) {
    let message = `The API server answered ${error.code}.`;
    let reason: string | undefined;
    if (typeof error.body === "string" && error.body !== "") {
      try {
        const status = JSON.parse(error.body) as { message?: string; reason?: string };
        message = status.message ?? message;
        reason = status.reason;
      } catch {
        message = error.body;
      }
    }
    return new KubeError(error.code, message, reason);
  }
  return new KubeError(0, error instanceof Error ? error.message : String(error));
}

/**
 * Runs a call, turning whatever it throws into a KubeError.
 *
 * @param call
 * @returns
 */
async function attempt<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw translate(error);
  }
}

/**
 * A read that's undefined, rather than an error, when the thing isn't
 * there.
 *
 * @param call
 * @returns
 */
async function optional<T>(call: () => Promise<T>): Promise<T | undefined> {
  try {
    return await attempt(call);
  } catch (error) {
    if (isNotFound(error)) {
      return undefined;
    }
    throw error;
  }
}

/**
 * The client for one KubeConfig.
 *
 * @param config
 * @returns
 */
function clientFor(config: KubeConfig): KubeClient {
  const core = config.makeApiClient(CoreV1Api);
  const custom = config.makeApiClient(CustomObjectsApi);
  const webapps = { group: GROUP, version: VERSION, plural: PLURAL };
  const merge = setHeaderOptions("Content-Type", PatchStrategy.MergePatch);
  const apply = setHeaderOptions("Content-Type", PatchStrategy.ServerSideApply);

  return {
    listNamespaces: () => attempt(async () => (await core.listNamespace()).items as Namespace[]),

    getNamespace: (name) => attempt(async () => (await core.readNamespace({ name })) as Namespace),

    patchNamespaceLabels: (name, labels) =>
      attempt(async () => (await core.patchNamespace({ name, body: { metadata: { labels } } }, merge)) as Namespace),

    patchNamespaceAnnotations: (name, annotations) =>
      attempt(
        async () => (await core.patchNamespace({ name, body: { metadata: { annotations } } }, merge)) as Namespace,
      ),

    createNamespace: (name, labels, annotations) =>
      attempt(
        async () => (await core.createNamespace({ body: { metadata: { name, labels, annotations } } })) as Namespace,
      ),

    listRegions: () =>
      attempt(async () => {
        const nodes = await core.listNode({ labelSelector: REGION_LABEL });
        const regions = nodes.items.map((node) => node.metadata?.labels?.[REGION_LABEL] ?? "");
        return [...new Set(regions.filter((region) => region !== ""))].toSorted();
      }),

    listResourceQuotas: (namespace) =>
      attempt(async () => {
        const list =
          namespace === undefined
            ? await core.listResourceQuotaForAllNamespaces()
            : await core.listNamespacedResourceQuota({ namespace });
        return list.items as ResourceQuota[];
      }),

    applyResourceQuota: (quota) =>
      attempt(async () => {
        await core.patchNamespacedResourceQuota(
          {
            name: quota.metadata.name,
            namespace: quota.metadata.namespace ?? "",
            body: { apiVersion: "v1", kind: "ResourceQuota", ...quota },
            fieldManager: FIELD_MANAGER,
            force: true,
          },
          apply,
        );
      }),

    deleteResourceQuota: (namespace, name) =>
      attempt(async () => {
        await optional(() => core.deleteNamespacedResourceQuota({ name, namespace }));
      }),

    getLimitRange: (namespace, name) =>
      optional(async () => (await core.readNamespacedLimitRange({ name, namespace })) as LimitRange),

    applyLimitRange: (limitRange) =>
      attempt(async () => {
        await core.patchNamespacedLimitRange(
          {
            name: limitRange.metadata.name,
            namespace: limitRange.metadata.namespace ?? "",
            body: { apiVersion: "v1", kind: "LimitRange", ...limitRange },
            fieldManager: FIELD_MANAGER,
            force: true,
          },
          apply,
        );
      }),

    deleteLimitRange: (namespace, name) =>
      attempt(async () => {
        await optional(() => core.deleteNamespacedLimitRange({ name, namespace }));
      }),

    getServiceAccount: (namespace, name) =>
      optional(async () => (await core.readNamespacedServiceAccount({ name, namespace })) as ServiceAccount),

    setImagePullSecrets: (namespace, name, secrets) =>
      attempt(async () => {
        const imagePullSecrets = secrets.map((secret) => ({ name: secret }));
        // A merge patch replaces the list whole, which is the point:
        // a Secret left off is no longer a default
        const patched = await optional(() =>
          core.patchNamespacedServiceAccount({ name, namespace, body: { imagePullSecrets } }, merge),
        );
        if (patched === undefined) {
          await core.createNamespacedServiceAccount({ namespace, body: { metadata: { name }, imagePullSecrets } });
        }
      }),

    listSecrets: (namespace) =>
      attempt(async () =>
        (await core.listNamespacedSecret({ namespace })).items.map((secret): SecretSummary => ({
          name: secret.metadata?.name ?? "",
          type: secret.type ?? "Opaque",
        })),
      ),

    listPostgresClusters: async (namespace) =>
      // A 404 means CloudNativePG isn't installed, so there are none
      (await optional(async () => {
        const list =
          namespace === undefined
            ? await custom.listClusterCustomObject(POSTGRES)
            : await custom.listNamespacedCustomObject({ ...POSTGRES, namespace });
        return (list as { items: PostgresCluster[] }).items;
      })) ?? [],

    listWebApplications: (namespace) =>
      attempt(async () => {
        const list =
          namespace === undefined
            ? await custom.listClusterCustomObject(webapps)
            : await custom.listNamespacedCustomObject({ ...webapps, namespace });
        return (list as { items: WebApplication[] }).items;
      }),

    getWebApplication: (namespace, name) =>
      attempt(async () => (await custom.getNamespacedCustomObject({ ...webapps, namespace, name })) as WebApplication),

    createWebApplication: (app) =>
      attempt(
        async () =>
          (await custom.createNamespacedCustomObject({
            ...webapps,
            namespace: app.metadata.namespace ?? "",
            body: app,
          })) as WebApplication,
      ),

    replaceWebApplication: (app) =>
      attempt(async () => {
        // Status belongs to Cirrus, and is ignored on the main
        // resource anyway; leaving it off keeps the request honest
        const { status: _status, ...body } = app;
        return (await custom.replaceNamespacedCustomObject({
          ...webapps,
          namespace: app.metadata.namespace ?? "",
          name: app.metadata.name,
          body,
        })) as WebApplication;
      }),

    createSecret: (namespace, name, data, labels, type = "Opaque") =>
      attempt(async () => {
        await core.createNamespacedSecret({
          namespace,
          body: { metadata: { name, namespace, labels }, type, stringData: data },
        });
      }),
  };
}

/**
 * The API, as the person whose ID token this is.
 *
 * @param idToken
 * @returns
 */
export function apiServerClientForToken(idToken: string): KubeClient {
  return clientFor(configForToken(idToken));
}

/**
 * The API, as the development kubeconfig's user.
 *
 * @returns
 */
export function apiServerClientForDevKubeconfig(): KubeClient {
  return clientFor(configForDevKubeconfig());
}
