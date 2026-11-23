/**
 * @file
 * Searching a listing of GitLab projects in the browser, as ./projects.ts
 * does instead of asking GitLab each time.
 */
import type { GitLabProject } from "./connections";

/**
 * The projects matching what's typed: every word somewhere in the path
 * or the name, in any case, the way GitLab's own search with
 * search_namespaces matches a group's name as well as the project's.
 *
 * @param projects
 * @param text
 * @returns
 */
export function matchProjects(projects: GitLabProject[], text: string): GitLabProject[] {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return projects;
  }
  return projects.filter((project) => {
    const haystack = `${project.path} ${project.name}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

/**
 * Projects from two listings, each once, in the order first seen.
 *
 * @param first
 * @param second
 * @returns
 */
export function mergeProjects(first: GitLabProject[], second: GitLabProject[]): GitLabProject[] {
  const seen = new Set(first.map((project) => project.id));
  return [...first, ...second.filter((project) => !seen.has(project.id))];
}
