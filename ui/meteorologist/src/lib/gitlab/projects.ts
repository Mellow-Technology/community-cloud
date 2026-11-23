/**
 * @file
 * The projects a connection's token can see, fetched once in the
 * browser and searched there.
 *
 * GitLab takes the better part of a second to list projects, and as
 * long again for each search. So the form asks as soon as it opens,
 * well before anyone reaches the project field, and the field filters
 * what came back as they type. Only a listing GitLab cut short (a full
 * page, PROJECT_PAGE) can be missing a match, and only then does a
 * search go to GitLab.
 */
import { findGitLabProjects, type ActionResult } from "../actions";
import type { GitLabProject } from "./connections";

// How long a listing is reused, so coming back to the form a while
// later shows projects made since
const FRESH_MS = 5 * 60_000;

const listings = new Map<string, { at: number; result: Promise<ActionResult<GitLabProject[]>> }>();

/**
 * A connection's projects, from the listing already asked for when
 * there's a recent one. A failed listing isn't kept, so the next ask
 * tries again.
 *
 * @param namespace
 * @param connection
 * @returns
 */
export function projectsFor(namespace: string, connection: string): Promise<ActionResult<GitLabProject[]>> {
  const key = `${namespace}/${connection}`;
  const kept = listings.get(key);
  if (kept !== undefined && Date.now() - kept.at < FRESH_MS) {
    return kept.result;
  }
  const result = findGitLabProjects(namespace, connection, "").then((found) => {
    if (!found.ok) listings.delete(key);
    return found;
  });
  listings.set(key, { at: Date.now(), result });
  return result;
}
