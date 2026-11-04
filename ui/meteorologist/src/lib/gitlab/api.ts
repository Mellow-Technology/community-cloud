/**
 * @file
 * The few GitLab REST calls Meteorologist makes, with a connection's
 * token: checking a token, listing the projects it can see, and
 * finding a project's images.
 *
 * Made from the server, never the browser, so the token never leaves
 * the cluster. With fixtures, a pretend GitLab answers instead, so the
 * forms can be tried without one.
 */
import "server-only";

import { getKubeMode } from "../config";
import type { GitLabProject } from "./connections";

/**
 * What Meteorologist asks of a GitLab.
 */
export interface GitLabApi {
  /**
   * Projects the token is a member of, most recently active first,
   * optionally only those matching a search.
   *
   * @param search
   * @returns
   */
  listProjects(search?: string): Promise<GitLabProject[]>;

  /**
   * The locations of a project's container registry repositories.
   *
   * @param projectId
   * @returns
   */
  listRepositories(projectId: number): Promise<string[]>;
}

// Long enough for a slow self-hosted GitLab, short enough that a form
// waiting on it doesn't look hung
const TIMEOUT_MS = 10_000;

// Enough to find a project by scrolling; searching finds the rest
const PER_PAGE = 50;

/**
 * A GitLab failure, as a sentence.
 *
 * @param status
 * @param body
 * @returns
 */
function describe(status: number, body: string): string {
  if (status === 401) {
    return "GitLab didn't accept the token. It may have expired or been revoked.";
  }
  if (status === 403) {
    return "GitLab refused: the token can't read projects. Give it the read_api or api scope, or Project: Read.";
  }
  let message = body.slice(0, 200);
  try {
    const parsed = JSON.parse(body) as { message?: unknown; error?: unknown };
    message = String(parsed.message ?? parsed.error ?? message);
  } catch {
    // Not JSON; the text will do
  }
  return `GitLab answered ${status}: ${message}`;
}

interface RawProject {
  id: number;
  path_with_namespace: string;
  name_with_namespace: string;
  web_url: string;
  default_branch?: string | null;
  container_registry_image_prefix?: string | null;
}

/**
 * The real API of one GitLab instance.
 *
 * @param url the instance, without a trailing slash
 * @param token
 * @returns
 */
function realGitLab(url: string, token: string): GitLabApi {
  const get = async <T>(path: string): Promise<T> => {
    let response: Response;
    try {
      response = await fetch(`${url}/api/v4${path}`, {
        headers: { "PRIVATE-TOKEN": token, Accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        cache: "no-store",
      });
    } catch (error) {
      throw new Error(`${url} couldn't be reached: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) {
      throw new Error(describe(response.status, await response.text()));
    }
    return (await response.json()) as T;
  };

  return {
    listProjects: async (search) => {
      const query = new URLSearchParams({
        membership: "true",
        order_by: "last_activity_at",
        per_page: String(PER_PAGE),
        archived: "false",
      });
      if (search !== undefined && search.trim() !== "") {
        query.set("search", search.trim());
        query.set("search_namespaces", "true");
      }
      const projects = await get<RawProject[]>(`/projects?${query}`);
      return projects.map((project) => ({
        id: project.id,
        path: project.path_with_namespace,
        name: project.name_with_namespace,
        webUrl: project.web_url,
        defaultBranch: project.default_branch ?? undefined,
        registryPrefix: project.container_registry_image_prefix ?? undefined,
      }));
    },

    listRepositories: async (projectId) =>
      (await get<Array<{ location: string }>>(`/projects/${projectId}/registry/repositories?per_page=100`)).map(
        (repository) => repository.location,
      ),
  };
}

// The pretend GitLab's projects
const FIXTURE_PROJECTS: GitLabProject[] = [
  {
    id: 101,
    path: "acme/shop",
    name: "Acme / shop",
    webUrl: "https://gitlab.com/acme/shop",
    defaultBranch: "main",
    registryPrefix: "registry.gitlab.com/acme/shop",
  },
  {
    id: 102,
    path: "acme/notes",
    name: "Acme / notes",
    webUrl: "https://gitlab.com/acme/notes",
    defaultBranch: "main",
    registryPrefix: "registry.gitlab.com/acme/notes",
  },
  {
    id: 103,
    path: "acme/platform/api",
    name: "Acme / platform / api",
    webUrl: "https://gitlab.com/acme/platform/api",
    defaultBranch: "develop",
    registryPrefix: "registry.gitlab.com/acme/platform/api",
  },
];

const fixtureGitLab: GitLabApi = {
  listProjects: async (search) =>
    FIXTURE_PROJECTS.filter(
      (project) => search === undefined || project.path.toLowerCase().includes(search.trim().toLowerCase()),
    ),
  listRepositories: async (projectId) =>
    projectId === 103
      ? ["registry.gitlab.com/acme/platform/api/server", "registry.gitlab.com/acme/platform/api/worker"]
      : FIXTURE_PROJECTS.filter((project) => project.id === projectId && project.id !== 102).map(
          (project) => project.registryPrefix ?? "",
        ),
};

/**
 * The GitLab a connection reaches.
 *
 * @param url
 * @param token
 * @returns
 */
export function gitLabFor(url: string, token: string): GitLabApi {
  return getKubeMode() === "fixtures" ? fixtureGitLab : realGitLab(url, token);
}
