/**
 * @file
 * GitLab connections: a namespace's GitLab access tokens, kept apart
 * from any one application.
 *
 * A connection is an ordinary Secret in the namespace, marked with a
 * label so it can be told from every other Secret, with the GitLab
 * instance it's for in an annotation and the token under "token". That
 * is all Cirrus needs — a WebApplication's source names a Secret and a
 * key — so one connection can serve every application in the
 * namespace, and a token is changed in one place.
 *
 * Meteorologist uses the same token to list the projects it can see,
 * so an application's project and image are chosen rather than typed.
 * That's why the token needs to read projects as well as what Cirrus
 * uses it for.
 */
import type { SecretSummary } from "../kube/types";
import { DEFAULT_GITLAB_URL, DEFAULT_TOKEN_KEY } from "../webapp/types";

// The label that makes a Secret a connection, and where its instance is
export const CONNECTION_LABEL = "community-cloud.technology/gitlab-connection";
export const URL_ANNOTATION = "community-cloud.technology/gitlab-url";
export const CONNECTION_KEY = DEFAULT_TOKEN_KEY;

/**
 * One connection, as the pages see it. Never the token.
 */
export interface GitLabConnection {
  name: string;
  url: string;
  createdAt?: string;
}

/**
 * A project the token can see.
 */
export interface GitLabProject {
  id: number;
  path: string;
  name: string;
  webUrl: string;
  defaultBranch?: string;
  // Where its images go, e.g. registry.gitlab.com/group/app
  registryPrefix?: string;
}

/**
 * The connections among a namespace's Secrets.
 *
 * @param secrets
 * @returns sorted by name
 */
export function connectionsIn(secrets: SecretSummary[]): GitLabConnection[] {
  return secrets
    .filter((secret) => secret.labels?.[CONNECTION_LABEL] === "true")
    .map((secret) => ({
      name: secret.name,
      url: secret.annotations?.[URL_ANNOTATION] ?? DEFAULT_GITLAB_URL,
      createdAt: secret.creationTimestamp,
    }))
    .toSorted((a, b) => a.name.localeCompare(b.name));
}

/**
 * A GitLab instance's address as written everywhere: scheme and host,
 * no trailing slash.
 *
 * @param url
 * @returns
 */
export function normaliseUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  return trimmed === "" ? DEFAULT_GITLAB_URL : trimmed;
}

/**
 * The name a new connection is given unless another is typed.
 *
 * @param url
 * @returns
 */
export function suggestedName(url: string): string {
  const host =
    normaliseUrl(url)
      .replace(/^https?:\/\//, "")
      .split("/")[0] ?? "";
  const slug = host
    .replace(/[^a-z0-9]+/gi, "-")
    .toLowerCase()
    .replace(/^-+|-+$/g, "");
  // gitlab.com is "gitlab-com", not "gitlab-gitlab-com"
  return (slug.startsWith("gitlab") ? slug : `gitlab-${slug}`).slice(0, 63).replace(/-+$/, "");
}

// Secret names are DNS subdomains
const SECRET_NAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;

/**
 * What's wrong with a new connection, as a sentence, or nothing.
 *
 * @param name
 * @param url
 * @param token
 * @returns
 */
export function connectionProblem(name: string, url: string, token: string): string | undefined {
  if (name.trim() === "" || name.trim().length > 253 || !SECRET_NAME.test(name.trim())) {
    return "Name it with lower-case letters, digits, hyphens and dots.";
  }
  if (!/^https?:\/\/[^\s/]+$/.test(normaliseUrl(url))) {
    return "The GitLab instance's address, such as https://gitlab.com, without a path.";
  }
  if (token.trim() === "") {
    return "Paste the access token.";
  }
  return undefined;
}

/**
 * Where on GitLab each kind of token is made.
 *
 * @param url the instance
 * @returns
 */
export function tokenPages(url: string): { personal: string; groups: string } {
  const base = normaliseUrl(url);
  return {
    personal: `${base}/-/user_settings/personal_access_tokens`,
    groups: `${base}/dashboard/groups`,
  };
}

/**
 * The image repository to run for a project: the registry's only
 * repository, or the one named like the project among several. With
 * none yet, it's the registry's prefix for the project, which is where a
 * pipeline's first image goes by default. Among several, none named like
 * the project, there's no telling which, so it's left to be chosen.
 *
 * @param project
 * @param repositories locations of the project's registry repositories
 * @returns
 */
export function imageFor(project: GitLabProject, repositories: string[]): string | undefined {
  if (repositories.length === 0) {
    return project.registryPrefix;
  }
  if (repositories.length === 1) {
    return repositories[0];
  }
  return repositories.find((location) => location === project.registryPrefix);
}
