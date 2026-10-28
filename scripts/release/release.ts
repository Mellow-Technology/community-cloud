/**
 * @file
 * What every release script shares: reading a component's version from
 * each place it's written, checking a release is safe to cut, and
 * pushing the tag its workflow publishes from.
 *
 * A component's version lives in more than one place — Cirrus's in
 * Cargo.toml, Cargo.lock and the image Cirrus.yaml pins — and a
 * release where they disagree ships something nobody asked for: an
 * installer applying an image that was never built, or an image whose
 * own manifest says it's another version. So nothing is tagged unless
 * every place agrees, and `set` writes them all at once.
 *
 * The tag is the whole release. Pushing it is what starts the
 * component's workflow, which builds and publishes; nothing here
 * builds anything. Releases are cut from what's on the remote's main,
 * as it is there, so what a tag names is always something that went
 * through review and CI.
 *
 *   bun scripts/release/<component>.ts               check, then tag and push
 *   bun scripts/release/<component>.ts --dry-run     check only
 *   bun scripts/release/<component>.ts set 0.2.0     write the version everywhere
 *   bun scripts/release/<component>.ts set minor     the same, from the current one
 */
import { $ } from "bun";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

// The repository's root, whichever directory the script is run from
export const ROOT = resolve(import.meta.dir, "../..");

// Releases are cut from here, on the remote
const RELEASE_BRANCH = "main";

// What the workflows accept as a version; anything else fails there,
// after the tag is already pushed
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/**
 * One place a component's version is written.
 */
export interface VersionPlace {
  // Relative to the repository's root
  file: string;
  // What it is, for messages: "the image Cirrus.yaml pins"
  describe: string;
  read(text: string): string | undefined;
  write(text: string, version: string): string;
}

export interface Component {
  // As it appears in tags: "cirrus" tags "cirrus-v1.2.3"
  name: string;
  title: string;
  // The workflow the tag starts, in .github/workflows
  workflow: string;
  // The first is where `set minor` and the like count from
  places: VersionPlace[];
  // Anything else that has to hold before this version can go out.
  // Each problem is a sentence; none means fine.
  checks?: (context: CheckContext) => Promise<string[]>;
}

export interface CheckContext {
  version: string;
  // Every tag on the remote, so a check needn't ask again
  remoteTags: Set<string>;
}

/**
 * A place in a file found by a regular expression whose first group is
 * the version, replaced where it stands so nothing else in the file
 * moves.
 *
 * @param file
 * @param describe
 * @param pattern
 * @returns
 */
export function patternPlace(file: string, describe: string, pattern: RegExp): VersionPlace {
  return {
    file,
    describe,
    read: (text) => pattern.exec(text)?.[1],
    write: (text, version) => {
      const match = pattern.exec(text);
      if (match?.[1] === undefined) {
        throw new Error(`Couldn't find ${describe} in ${file}`);
      }
      const at = match.index + match[0].indexOf(match[1]);
      return text.slice(0, at) + version + text.slice(at + match[1].length);
    },
  };
}

/**
 * A package.json's own version: the first "version" key, which is the
 * top level's in every package.json we have.
 *
 * @param file
 * @returns
 */
export function packageJsonPlace(file: string): VersionPlace {
  return patternPlace(file, `the version in ${file}`, /^\s*"version":\s*"([^"]+)"/m);
}

/**
 * @param version
 * @returns
 */
export function parseVersion(version: string) {
  const match = SEMVER.exec(version);
  if (!match) {
    return undefined;
  }
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])] as const,
    prerelease: match[4]?.split(".") ?? [],
  };
}

/**
 * Semver's ordering: numbers first, then a prerelease before the
 * release it leads up to, then prerelease identifiers one by one.
 *
 * @param a
 * @param b
 * @returns negative, zero or positive, as for a sort
 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) {
    throw new Error(`Can't compare ${a} and ${b}`);
  }
  for (let i = 0; i < 3; i++) {
    const difference = left.core[i]! - right.core[i]!;
    if (difference !== 0) {
      return difference;
    }
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return right.prerelease.length - left.prerelease.length;
  }
  for (let i = 0; i < Math.max(left.prerelease.length, right.prerelease.length); i++) {
    const x = left.prerelease[i];
    const y = right.prerelease[i];
    if (x === undefined || y === undefined) {
      return x === undefined ? -1 : 1;
    }
    const numeric = /^\d+$/.test(x) && /^\d+$/.test(y);
    const difference = numeric ? Number(x) - Number(y) : x.localeCompare(y);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

/**
 * The version `set` was asked for: one written out, or "major",
 * "minor" or "patch" counted from the current one.
 *
 * @param current
 * @param requested
 * @returns
 */
export function nextVersion(current: string, requested: string): string {
  const parsed = parseVersion(current);
  if (requested === "major" || requested === "minor" || requested === "patch") {
    if (!parsed) {
      throw new Error(`The current version, ${current}, isn't semver, so there's nothing to count from`);
    }
    const [major, minor, patch] = parsed.core;
    // A prerelease's own release is the next patch, as npm version has it
    if (requested === "patch") {
      return parsed.prerelease.length > 0 ? `${major}.${minor}.${patch}` : `${major}.${minor}.${patch + 1}`;
    }
    return requested === "minor" ? `${major}.${minor + 1}.0` : `${major + 1}.0.0`;
  }
  if (!parseVersion(requested)) {
    throw new Error(`"${requested}" isn't a version: 1.2.3, 1.2.3-rc.1, or major, minor or patch`);
  }
  return requested;
}

/**
 * The tag a component's version is released under.
 *
 * @param component
 * @param version
 * @returns
 */
export function tagFor(component: Pick<Component, "name">, version: string): string {
  return `${component.name}-v${version}`;
}

/**
 * What each place says now.
 *
 * @param component
 * @returns
 */
async function readPlaces(component: Component) {
  return Promise.all(
    component.places.map(async (place) => {
      const text = await readFile(join(ROOT, place.file), "utf8");
      return { place, text, version: place.read(text) };
    }),
  );
}

/**
 * Every tag on the remote. Asked of the remote, not taken from local
 * tags, which can be missing some or carry ones never pushed.
 *
 * @param remote
 * @returns
 */
export async function listRemoteTags(remote: string): Promise<Set<string>> {
  const output = await $`git ls-remote --tags --refs ${remote}`.cwd(ROOT).quiet().text();
  return new Set(
    output
      .split("\n")
      .map((line) => line.split("\t")[1]?.replace(/^refs\/tags\//, ""))
      .filter((tag): tag is string => tag !== undefined && tag !== ""),
  );
}

/**
 * The newest version already released, from the remote's tags.
 *
 * @param component
 * @param tags
 * @returns
 */
export function latestReleased(component: Pick<Component, "name">, tags: Iterable<string>): string | undefined {
  const prefix = tagFor(component, "");
  return [...tags]
    .filter((tag) => tag.startsWith(prefix) && parseVersion(tag.slice(prefix.length)))
    .map((tag) => tag.slice(prefix.length))
    .toSorted(compareVersions)
    .at(-1);
}

/**
 * The GitHub page listing a workflow's runs, when the remote is on
 * GitHub.
 *
 * @param remote
 * @param workflow
 * @returns
 */
async function workflowUrl(remote: string, workflow: string): Promise<string | undefined> {
  const url = (await $`git remote get-url ${remote}`.cwd(ROOT).quiet().nothrow().text()).trim();
  const repository = /github\.com[:/](.+?)(?:\.git)?$/.exec(url)?.[1];
  return repository ? `https://github.com/${repository}/actions/workflows/${workflow}` : undefined;
}

/**
 * @param question
 * @returns
 */
async function confirm(question: string): Promise<boolean> {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await prompt.question(`${question} [y/N] `)).trim());
  } finally {
    prompt.close();
  }
}

/**
 * `set`: the version written into every place, and nothing committed.
 * It goes to main the way anything else does.
 *
 * @param component
 * @param requested
 */
async function setVersion(component: Component, requested: string): Promise<void> {
  const places = await readPlaces(component);
  const current = places[0]?.version;
  if (current === undefined) {
    throw new Error(`Couldn't find ${component.places[0]?.describe}`);
  }
  const version = nextVersion(current, requested);
  for (const { place, text, version: was } of places) {
    await writeFile(join(ROOT, place.file), place.write(text, version));
    console.log(`  ${place.file}: ${was ?? "?"} → ${version}`);
  }
  console.log(
    `\n${component.title} is now ${version} in every place it's written. Commit it and get it onto ` +
      `${RELEASE_BRANCH}, then run this again without "set" to tag it.`,
  );
}

/**
 * Releasing: every check, then the tag, pushed.
 *
 * @param component
 * @param options
 * @param options.remote
 * @param options.dryRun
 * @param options.yes
 */
async function release(component: Component, options: { remote: string; dryRun: boolean; yes: boolean }) {
  const { remote } = options;
  const problems: string[] = [];

  // Every place agrees, on a version the workflow will take
  const places = await readPlaces(component);
  for (const { place, version } of places) {
    console.log(`  ${place.file}: ${version ?? `no version found (${place.describe})`}`);
  }
  const versions = new Set(places.map(({ version }) => version));
  const version = places[0]?.version;
  if (version === undefined || versions.has(undefined)) {
    problems.push("A version couldn't be found where it should be; see above.");
  } else if (versions.size > 1) {
    problems.push(
      `The places disagree. \`bun scripts/release/${component.name}.ts set <version>\` writes one to all of them.`,
    );
  } else if (!parseVersion(version)) {
    problems.push(`${version} isn't semver, which the workflow refuses: 1.2.3 or 1.2.3-rc.1.`);
  }

  // What's being tagged is the remote's main, exactly
  await $`git fetch --quiet ${remote} ${RELEASE_BRANCH}`.cwd(ROOT);
  const head = (await $`git rev-parse HEAD`.cwd(ROOT).quiet().text()).trim();
  const main = (await $`git rev-parse ${remote}/${RELEASE_BRANCH}`.cwd(ROOT).quiet().text()).trim();
  if (head !== main) {
    problems.push(
      `HEAD (${head.slice(0, 7)}) isn't ${remote}/${RELEASE_BRANCH} (${main.slice(0, 7)}). Releases are tagged ` +
        `on what's merged: \`git switch --detach ${remote}/${RELEASE_BRANCH}\`, or pull.`,
    );
  }
  // A changed file would mean the checks above read something that
  // isn't what's being tagged
  const changed = (await $`git status --porcelain --untracked-files=no`.cwd(ROOT).quiet().text()).trimEnd();
  if (changed !== "") {
    problems.push(
      `There are uncommitted changes, so what was checked isn't what would be tagged:\n${changed.replace(/^/gm, "      ")}`,
    );
  }

  // A new version, and newer than the last
  const remoteTags = await listRemoteTags(remote);
  const latest = latestReleased(component, remoteTags);
  if (version !== undefined && parseVersion(version)) {
    const tag = tagFor(component, version);
    const local = (await $`git tag --list ${tag}`.cwd(ROOT).quiet().text()).trim();
    if (remoteTags.has(tag)) {
      problems.push(`${tag} is already released. Set a new version first.`);
    } else if (local !== "") {
      problems.push(`${tag} exists here but was never pushed. Delete it with \`git tag -d ${tag}\` if it's stale.`);
    }
    if (latest !== undefined && !remoteTags.has(tag) && compareVersions(version, latest) <= 0) {
      problems.push(`${version} isn't newer than ${latest}, the last ${component.title} released.`);
    }
    problems.push(...((await component.checks?.({ version, remoteTags })) ?? []));
  }

  console.log(`  last released: ${latest ?? "nothing yet"}`);
  if (problems.length > 0 || version === undefined) {
    console.error(`\nNot releasing ${component.title}:`);
    for (const problem of problems) {
      console.error(`  - ${problem}`);
    }
    process.exit(1);
  }

  const tag = tagFor(component, version);
  const commit = (await $`git log -1 --format=%h\ %s HEAD`.cwd(ROOT).quiet().text()).trim();
  console.log(`\nReady: ${tag} on ${commit}`);
  if (options.dryRun) {
    console.log("A dry run, so nothing was tagged.");
    return;
  }
  if (!options.yes && !(await confirm(`Tag ${tag} and push it to ${remote}?`))) {
    console.log("Nothing was tagged.");
    return;
  }

  await $`git tag -a ${tag} -m ${`${component.title} ${version}`}`.cwd(ROOT);
  const pushed = await $`git push ${remote} refs/tags/${tag}`.cwd(ROOT).nothrow();
  if (pushed.exitCode !== 0) {
    // Left behind, it would make the next attempt refuse
    await $`git tag -d ${tag}`.cwd(ROOT).quiet();
    console.error(`\nPushing ${tag} failed, so the tag was removed here too.`);
    process.exit(1);
  }
  const url = await workflowUrl(remote, component.workflow);
  console.log(`\nPushed ${tag}. The release is built by ${component.workflow}${url ? `: ${url}` : "."}`);
}

const USAGE = (name: string) => `Usage:
  bun scripts/release/${name}.ts [--dry-run] [--yes] [--remote <name>]
      Check every place ${name}'s version is written agrees, that HEAD is
      the remote's ${RELEASE_BRANCH} and the version is unreleased, then tag
      ${name}-v<version> and push it.
  bun scripts/release/${name}.ts set <version | major | minor | patch>
      Write a new version into every place, without committing it.`;

/**
 * The command line every release script runs.
 *
 * @param component
 * @param argv the arguments after the script's own path
 */
export async function main(component: Component, argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = [...argv];
  if (args.includes("--help") || args.includes("-h")) {
    console.log(USAGE(component.name));
    return;
  }
  if (args[0] === "set") {
    if (args.length !== 2) {
      console.error(USAGE(component.name));
      process.exit(2);
    }
    await setVersion(component, args[1]!);
    return;
  }

  const options = { remote: "origin", dryRun: false, yes: false };
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--yes" || arg === "-y") {
      options.yes = true;
    } else if (arg === "--remote" && args[0] !== undefined) {
      options.remote = args.shift()!;
    } else {
      console.error(`Unknown argument "${arg}".\n\n${USAGE(component.name)}`);
      process.exit(2);
    }
  }
  console.log(`Releasing ${component.title}\n`);
  await release(component, options);
}
