/**
 * @file
 * What someone with access to only some namespaces can reach.
 *
 * A cluster admin's reads are one request each, across every
 * namespace. Someone given a role in a few namespaces gets a 403 for
 * those, even though every object in their own namespaces is theirs to
 * see. And Kubernetes can't say which namespaces those are: a person
 * can ask whether they may do something in one namespace, not where
 * they may do it.
 *
 * So the pages go through here. The cluster-wide read is tried first,
 * and when it's refused the same read is made for each namespace the
 * person can get. All of it is done as them, so RBAC still decides
 * everything; the only thing that isn't is the list of names to try
 * (KubeClient.listNamespaceNames), and a name only comes out of here
 * once the API server has handed the person that namespace.
 */
import { isForbidden, isNotFound, settle, type KubeClient, type Permission } from "../kube/client";
import type { Namespace } from "../kube/types";

/**
 * The namespaces the person can see.
 *
 * @param kube
 * @returns
 */
export async function reachableNamespaces(kube: KubeClient): Promise<Namespace[]> {
  const listed = await settle(() => kube.listNamespaces());
  if (listed.ok) {
    return listed.value;
  }
  if (!isForbidden(listed.error)) {
    throw listed.error;
  }

  const names = await kube.listNamespaceNames();
  const reads = await Promise.all(names.map((name) => settle(() => kube.getNamespace(name))));
  return reads.flatMap((read) => {
    if (read.ok) {
      return [read.value];
    }
    // Refused is most of them, and gone is one deleted just now
    if (isForbidden(read.error) || isNotFound(read.error)) {
      return [];
    }
    throw read.error;
  });
}

/**
 * Reads something across every namespace the person can, in one
 * request if they're allowed to and one per namespace if not.
 *
 * Having a namespace doesn't mean being allowed every kind of thing in
 * it, so one that refuses is left out. If they all do, the person isn't
 * allowed this at all, which is the 403 and not an empty list.
 *
 * @param namespaces what reachableNamespaces found
 * @param read the read, given a namespace or nothing for all of them
 * @returns
 */
export async function acrossNamespaces<T>(
  namespaces: Namespace[],
  read: (namespace?: string) => Promise<T[]>,
): Promise<T[]> {
  const everywhere = await settle(() => read());
  if (everywhere.ok) {
    return everywhere.value;
  }
  if (!isForbidden(everywhere.error)) {
    throw everywhere.error;
  }
  if (namespaces.length === 0) {
    return [];
  }

  const reads = await Promise.all(namespaces.map((ns) => settle(() => read(ns.metadata.name))));
  const refusals = reads.filter((each) => !each.ok && isForbidden(each.error));
  if (refusals.length === reads.length) {
    throw everywhere.error;
  }
  return reads.flatMap((each) => {
    if (each.ok) {
      return each.value;
    }
    if (isForbidden(each.error)) {
      return [];
    }
    throw each.error;
  });
}

/**
 * Which of some namespaces the person may do something in. For deciding
 * what to offer, so a question the API server can't answer counts as
 * no: the worst that does is hide a button until the next load.
 *
 * @param kube
 * @param permission what they'd do, without a namespace
 * @param names
 * @returns the names of the ones that allow it
 */
export async function namespacesAllowing(
  kube: Pick<KubeClient, "canI">,
  permission: Omit<Permission, "namespace" | "name">,
  names: string[],
): Promise<Set<string>> {
  const ask = (asked: Permission) => kube.canI(asked).catch(() => false);
  // One question rather than one per namespace, for a cluster admin
  if (await ask(permission)) {
    return new Set(names);
  }
  const answers = await Promise.all(
    names.map((namespace) =>
      // A rule about a namespace itself goes by its name, and a
      // RoleBinding in it reaches it as if the namespace held itself
      ask({ ...permission, namespace, name: permission.resource === "namespaces" ? namespace : undefined }),
    ),
  );
  return new Set(names.filter((_, index) => answers[index]));
}
