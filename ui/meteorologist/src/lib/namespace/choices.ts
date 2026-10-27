/**
 * @file
 * The namespaces an application could go in, with what the form needs
 * to know about each: its labels, whether it has a Postgres yet, and
 * how much storage its quota leaves.
 */
import "server-only";

import type { NamespaceChoice } from "@/components/WebApplicationForm";
import { settle, type KubeClient } from "../kube/client";
import type { Namespace } from "../kube/types";
import { POSTGRES_CLUSTER } from "../postgres";

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
  // Either may be refused to someone who can't see the whole cluster;
  // then the form just doesn't say what it can't know
  const [clusters, quotas] = await Promise.all([
    settle(() => kube.listPostgresClusters(only)),
    settle(() => kube.listResourceQuotas(only)),
  ]);

  return namespaces
    .map((ns): NamespaceChoice => {
      const name = ns.metadata.name;
      const storage = quotas.ok
        ? quotas.value.find((quota) => quota.metadata.namespace === name && quota.spec?.hard?.["requests.storage"])
        : undefined;
      return {
        name,
        labels: ns.metadata.labels ?? {},
        hasPostgres: clusters.ok
          ? clusters.value.some(
              (cluster) => cluster.metadata.namespace === name && cluster.metadata.name === POSTGRES_CLUSTER,
            )
          : undefined,
        storageQuota: storage?.spec?.hard?.["requests.storage"],
        storageUsed: storage?.status?.used?.["requests.storage"],
      };
    })
    .toSorted((a, b) => a.name.localeCompare(b.name));
}
