/**
 * @file
 * The namespaces an application could go in, with what the form needs
 * to know about each: its labels, whether it has a Postgres yet, how
 * much storage its quota leaves, its GitLab connections, its registry
 * credentials and the registries they're for, which DNS providers
 * publish it, and its shared environment values, by name only.
 */
import "server-only";

import type { NamespaceChoice } from "@/components/WebApplicationForm";
import { providersFor } from "../dns/providers";
import { SHARED_ENV, type SharedKind } from "../environment";
import { connectionsIn } from "../gitlab/connections";
import { settle, type KubeClient } from "../kube/client";
import type { Namespace, SecretSummary } from "../kube/types";
import { acrossNamespaces, namespacesAllowing } from "./access";
import { PULL_SECRET_TYPE } from "./settings";
import { REGISTRY_ANNOTATION, registriesIn, type PullSecret } from "../webapp/registry";
import { POSTGRES_CLUSTER } from "../postgres";

/**
 * A namespace's pull Secrets and their registries: from Meteorologist's
 * annotation, or, for one made otherwise, from the Secret's own
 * .dockerconfigjson. Only the registry hosts leave the server.
 *
 * @param kube
 * @param namespace
 * @param secrets
 * @returns
 */
async function pullSecretsIn(kube: KubeClient, namespace: string, secrets: SecretSummary[]): Promise<PullSecret[]> {
  return Promise.all(
    secrets
      .filter((secret) => secret.type === PULL_SECRET_TYPE)
      .map(async (secret) => {
        const annotated = secret.annotations?.[REGISTRY_ANNOTATION];
        if (annotated !== undefined) {
          return { name: secret.name, registries: [annotated] };
        }
        const read = await settle(() => kube.readSecretValue(namespace, secret.name, ".dockerconfigjson"));
        return { name: secret.name, registries: read.ok ? registriesIn(read.value) : [] };
      }),
  );
}

/**
 * @param kube
 * @param namespaces
 * @param only the one namespace these all are, to ask about it alone
 *   rather than the whole cluster
 * @returns sorted by name
 */
export async function namespaceChoices(
  kube: KubeClient,
  namespaces: Namespace[],
  only?: string,
): Promise<NamespaceChoice[]> {
  const names = namespaces.map((ns) => ns.metadata.name);
  const across = <T>(read: (namespace?: string) => Promise<T[]>) =>
    settle(() => (only === undefined ? acrossNamespaces(namespaces, read) : read(only)));

  // Any of these may be refused; then the form just doesn't say what
  // it can't know
  const [clusters, quotas, dns, labelling, secrets] = await Promise.all([
    across((namespace) => kube.listPostgresClusters(namespace)),
    across((namespace) => kube.listResourceQuotas(namespace)),
    settle(() => kube.listDnsProviders()),
    namespacesAllowing(kube, { verb: "patch", resource: "namespaces" }, names),
    // Connections are per namespace, so asked of each; one that's
    // refused just has none offered
    Promise.all(namespaces.map((ns) => settle(() => kube.listSecrets(ns.metadata.name)))),
  ]);
  // Names only: a shared secret's value never goes to the form
  const shared = await Promise.all(
    namespaces.map(async (ns): Promise<Array<{ key: string; kind: SharedKind }> | undefined> => {
      const [config, secret] = await Promise.all([
        settle(() => kube.getConfigMap(ns.metadata.name, SHARED_ENV)),
        settle(() => kube.listSecretKeys(ns.metadata.name, SHARED_ENV)),
      ]);
      if (!config.ok && !secret.ok) return undefined;
      return [
        ...Object.keys((config.ok ? config.value?.data : undefined) ?? {}).map((key) => ({
          key,
          kind: "config" as const,
        })),
        ...((secret.ok ? secret.value : undefined) ?? []).map((key) => ({ key, kind: "secret" as const })),
      ].sort((a, b) => a.key.localeCompare(b.key));
    }),
  );
  const pullSecrets = await Promise.all(
    namespaces.map((ns, index) => {
      const listed = secrets[index];
      return listed?.ok ? pullSecretsIn(kube, ns.metadata.name, listed.value) : undefined;
    }),
  );

  return namespaces
    .map((ns, index): NamespaceChoice => {
      const name = ns.metadata.name;
      const listed = secrets[index];
      const storage = quotas.ok
        ? quotas.value.find((quota) => quota.metadata.namespace === name && quota.spec?.hard?.["requests.storage"])
        : undefined;
      return {
        name,
        labels: ns.metadata.labels ?? {},
        canChangeCapabilities: labelling.has(name),
        hasPostgres: clusters.ok
          ? clusters.value.some(
              (cluster) => cluster.metadata.namespace === name && cluster.metadata.name === POSTGRES_CLUSTER,
            )
          : undefined,
        storageQuota: storage?.spec?.hard?.["requests.storage"],
        storageUsed: storage?.status?.used?.["requests.storage"],
        gitlabConnections: listed?.ok ? connectionsIn(listed.value) : undefined,
        pullSecrets: pullSecrets[index],
        dnsProviders: dns.ok ? providersFor(dns.value, name) : undefined,
        sharedEnv: shared[index],
      };
    })
    .toSorted((a, b) => a.name.localeCompare(b.name));
}
