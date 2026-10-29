/**
 * @file
 * A namespace's GitLab connections: the tokens its applications choose
 * their projects and images through, and update with.
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ErrorNotice } from "@/components/ErrorNotice";
import { GitLabConnections } from "@/components/GitLabConnections";
import { PageHeader } from "@/components/PageHeader";
import { connectionsIn } from "@/lib/gitlab/connections";
import { getKube } from "@/lib/kube";
import { isNotFound, settle } from "@/lib/kube/client";

/**
 * @param props
 * @param props.params
 * @returns
 */
export async function generateMetadata({ params }: { params: Promise<{ name: string }> }): Promise<Metadata> {
  return { title: `GitLab · ${decodeURIComponent((await params).name)}` };
}

/**
 * @param props
 * @param props.params
 * @returns
 */
export default async function GitLabPage({ params }: { params: Promise<{ name: string }> }) {
  const name = decodeURIComponent((await params).name);
  const kube = await getKube();
  const [namespace, secrets, apps] = await Promise.all([
    settle(() => kube.getNamespace(name)),
    settle(() => kube.listSecrets(name)),
    settle(() => kube.listWebApplications(name)),
  ]);
  if (!namespace.ok && isNotFound(namespace.error)) {
    notFound();
  }

  const usedBy: Record<string, string[]> = {};
  for (const app of apps.ok ? apps.value : []) {
    const secret = app.spec.source?.gitlab?.tokenSecret.name;
    if (secret !== undefined) {
      (usedBy[secret] ??= []).push(app.metadata.name);
    }
  }

  return (
    <>
      <PageHeader
        eyebrow={name}
        title="GitLab"
        description="Tokens this namespace's applications reach GitLab with: to choose their project and image, and to roll out each image a pipeline builds."
        back={{ href: `/namespaces/${encodeURIComponent(name)}`, label: name }}
      />
      {secrets.ok ? (
        <GitLabConnections namespace={name} connections={connectionsIn(secrets.value)} usedBy={usedBy} />
      ) : (
        <ErrorNotice error={secrets.error} title="Couldn't list this namespace's Secrets" />
      )}
    </>
  );
}
