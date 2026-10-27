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
import { KubeError, type KubeClient } from "./client";
import type { Namespace } from "./types";

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
 * The client for one KubeConfig.
 *
 * @param config
 * @returns
 */
function clientFor(config: KubeConfig): KubeClient {
  const core = config.makeApiClient(CoreV1Api);
  const custom = config.makeApiClient(CustomObjectsApi);
  const webapps = { group: GROUP, version: VERSION, plural: PLURAL };

  return {
    listNamespaces: () => attempt(async () => (await core.listNamespace()).items as Namespace[]),

    getNamespace: (name) => attempt(async () => (await core.readNamespace({ name })) as Namespace),

    patchNamespaceLabels: (name, labels) =>
      attempt(
        async () =>
          (await core.patchNamespace(
            { name, body: { metadata: { labels } } },
            setHeaderOptions("Content-Type", PatchStrategy.MergePatch),
          )) as Namespace,
      ),

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

    createSecret: (namespace, name, data, labels) =>
      attempt(async () => {
        await core.createNamespacedSecret({
          namespace,
          body: { metadata: { name, namespace, labels }, type: "Opaque", stringData: data },
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
