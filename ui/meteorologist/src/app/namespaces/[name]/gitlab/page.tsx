/**
 * @file
 * Where a namespace's GitLab connections used to have a page of their
 * own. They're the namespace page's Integration tab now; links made
 * before still land there.
 */
import { redirect } from "next/navigation";

/**
 * @param props
 * @param props.params
 */
export default async function GitLabPage({ params }: { params: Promise<{ name: string }> }) {
  redirect(`/namespaces/${(await params).name}?tab=integration`);
}
