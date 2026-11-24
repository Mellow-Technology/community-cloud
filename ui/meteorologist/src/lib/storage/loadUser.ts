/**
 * @file
 * Everything a user's page shows, read as the person: the S3Identity,
 * its keys, and the buckets that name it. Both of a user's tabs start
 * from this.
 */
import "server-only";

import { getKube } from "../kube";
import { settle, type Settled } from "../kube/client";
import { acrossNamespaces, reachableNamespaces } from "../namespace/access";
import type { Bucket, BucketAction, S3CredentialsSummary, S3Identity } from "./types";
import { bucketsFor, keysFor } from "./users";

export interface LoadedUser {
  namespace: string;
  name: string;
  identity: Settled<S3Identity>;
  // Its keys, when they could be listed
  keys?: Settled<S3CredentialsSummary[]>;
  // Every key in its namespace, for naming a new one
  namespaceKeys?: S3CredentialsSummary[];
  buckets?: Settled<Array<{ bucket: Bucket; actions: BucketAction[] }>>;
}

/**
 * @param rawNamespace as it came in the address
 * @param rawName as it came in the address
 * @returns
 */
export async function loadUser(rawNamespace: string, rawName: string): Promise<LoadedUser> {
  const namespace = decodeURIComponent(rawNamespace);
  const name = decodeURIComponent(rawName);
  const kube = await getKube();
  const identity = await settle(() => kube.getS3Identity(namespace, name));
  if (!identity.ok) {
    return { namespace, name, identity };
  }
  // Its keys are in its own namespace; the buckets naming it may be in
  // any the person can see
  const namespaces = await settle(() => reachableNamespaces(kube));
  const [credentials, buckets] = await Promise.all([
    settle(() => kube.listS3Credentials(namespace)),
    settle(() => acrossNamespaces(namespaces.ok ? namespaces.value : [], (each) => kube.listBuckets(each))),
  ]);
  return {
    namespace,
    name,
    identity,
    keys: credentials.ok ? { ok: true, value: keysFor(identity.value, credentials.value) } : credentials,
    namespaceKeys: credentials.ok ? credentials.value : [],
    buckets: buckets.ok ? { ok: true, value: bucketsFor(identity.value, buckets.value) } : buckets,
  };
}
