/**
 * @file
 * The ServiceOfferings the person can see, for the application form.
 */
import "server-only";

import { settle, type KubeClient } from "../kube/client";
import type { Namespace } from "../kube/types";
import { acrossNamespaces } from "../namespace/access";
import { offeringChoice, type OfferingChoice } from "./present";

/**
 * Every offering in the namespaces the person can see. One that's
 * refused, or a cluster without the CRD, just offers none.
 *
 * @param kube
 * @param namespaces
 * @returns
 */
export async function offeringChoices(kube: KubeClient, namespaces: Namespace[]): Promise<OfferingChoice[]> {
  const listed = await settle(() => acrossNamespaces(namespaces, (each) => kube.listServiceOfferings(each)));
  return listed.ok ? listed.value.map(offeringChoice) : [];
}
