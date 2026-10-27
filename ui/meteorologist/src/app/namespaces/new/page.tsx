/**
 * @file
 * Making a namespace, with its capabilities and settings from the
 * start.
 */
import type { Metadata } from "next";

import { NamespaceSettingsForm } from "@/components/NamespaceSettingsForm";
import { PageHeader } from "@/components/PageHeader";
import { getKube } from "@/lib/kube";
import { settle } from "@/lib/kube/client";
import { emptyNamespaceForm } from "@/lib/namespace/settings";

export const metadata: Metadata = { title: "New namespace" };

/**
 * @returns
 */
export default async function NewNamespacePage() {
  const kube = await getKube();
  // Listing nodes takes more than most people are allowed; without it
  // the region is typed rather than chosen
  const regions = await settle(() => kube.listRegions());

  return (
    <>
      <PageHeader
        eyebrow="Cluster"
        title="New namespace"
        description="A home for a team's or a project's applications: what it may use, where it runs, and which registries it can pull from."
        back={{ href: "/namespaces", label: "Namespaces" }}
      />
      <NamespaceSettingsForm initial={emptyNamespaceForm()} regions={regions.ok ? regions.value : []} />
    </>
  );
}
