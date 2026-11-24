/**
 * @file
 * What the bucket form offers: the namespaces a bucket could go in, and
 * whether SeaweedFS takes buckets from each, and the S3 users it could
 * give access to.
 */
import "server-only";

import type { BucketNamespaceChoice } from "@/components/BucketForm";
import { CAPABILITIES, hasCapability } from "../capabilities";
import { settle, type KubeClient } from "../kube/client";
import type { Namespace } from "../kube/types";
import { userChoices, type UserChoice } from "./users";

/**
 * @param _kube
 * @param namespaces
 * @returns sorted by name
 */
export async function bucketNamespaceChoices(
  _kube: KubeClient,
  namespaces: Namespace[],
): Promise<BucketNamespaceChoice[]> {
  const buckets = CAPABILITIES.find((capability) => capability.id === "buckets")!;
  return namespaces
    .map((ns) => ({ name: ns.metadata.name, allowsBuckets: hasCapability(ns.metadata.labels, buckets) }))
    .toSorted((a, b) => a.name.localeCompare(b.name));
}

/**
 * Every S3 user the person can see, across the namespaces they can, to
 * give access to a bucket. A namespace whose users can't be listed just
 * has none offered.
 *
 * @param kube
 * @param namespaces
 * @returns
 */
export async function visibleUsers(kube: KubeClient, namespaces: Namespace[]): Promise<UserChoice[]> {
  const listed = await Promise.all(namespaces.map((ns) => settle(() => kube.listS3Identities(ns.metadata.name))));
  return userChoices(listed.flatMap((each) => (each.ok ? each.value : [])));
}
