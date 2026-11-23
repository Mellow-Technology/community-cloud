import { describe, expect, test } from "bun:test";

import type { GitLabProject } from "./connections";
import { matchProjects, mergeProjects } from "./search";

const project = (id: number, path: string, name: string): GitLabProject => ({
  id,
  path,
  name,
  webUrl: `https://gitlab.com/${path}`,
});

const projects = [
  project(1, "sonic-space/bassrig", "Sonic Space / BassRig"),
  project(2, "sonic-space/firstcall-keys", "Sonic Space / FirstCall Keys"),
  project(3, "mellow-technology/mellow-hq", "Mellow Technology / Mellow HQ"),
];

describe("searching projects in the browser", () => {
  test("matches the group as well as the project, in any case", () => {
    expect(matchProjects(projects, "SONIC").map((each) => each.id)).toEqual([1, 2]);
    expect(matchProjects(projects, "hq").map((each) => each.id)).toEqual([3]);
  });

  test("needs every word, wherever it is", () => {
    expect(matchProjects(projects, "sonic keys").map((each) => each.id)).toEqual([2]);
    expect(matchProjects(projects, "first call").map((each) => each.id)).toEqual([2]);
    expect(matchProjects(projects, "sonic hq")).toEqual([]);
  });

  test("shows everything for nothing typed", () => {
    expect(matchProjects(projects, "  ")).toBe(projects);
  });

  test("merges listings without repeating a project", () => {
    const more = [project(2, "sonic-space/firstcall-keys", "x"), project(4, "sonic-space/vocalrig", "y")];
    expect(mergeProjects(projects, more).map((each) => each.id)).toEqual([1, 2, 3, 4]);
  });
});
