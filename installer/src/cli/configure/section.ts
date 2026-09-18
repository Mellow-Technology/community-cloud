/**
 * @file
 * The shape of a configuration section, and the small amount of
 * machinery every section needs.
 *
 * The interactive installer is a list of sections rather than one long
 * script, because it has two jobs: walking someone through a new
 * configuration, and letting someone change one part of an existing
 * one without being asked about the other eight. A section knows how
 * to describe what it currently holds and how to ask about it, and the
 * runner does the rest.
 */

/**
 * A Community Cloud configuration being built or edited.
 *
 * Deliberately loose: a configuration can hold keys this installer
 * doesn't manage, and editing one section shouldn't disturb them.
 */
export type ConfigDraft = Record<string, unknown>;

export interface ConfigSection {
  // Used to name the section on the command line
  name: string;

  // Shown in the menu
  title: string;

  // One line saying what the configuration currently holds for this
  // section, so the menu is worth reading
  describe: (draft: ConfigDraft) => string;

  // Ask the questions and change the draft
  run: (draft: ConfigDraft) => Promise<void>;
}

/**
 * Read a dotted path out of a draft.
 *
 * @param draft
 * @param path
 * @returns
 */
export function readPath(draft: ConfigDraft, path: string): any {
  let current: any = draft;

  for (const segment of path.split(".")) {
    if (current === undefined || current === null) {
      return undefined;
    }

    current = current[segment];
  }

  return current;
}

/**
 * The first of several paths that actually holds something.
 *
 * Values have moved around as this project has grown, so a prompt
 * offers whatever it can find as its default rather than making
 * someone type it again.
 *
 * @param draft
 * @param paths
 * @returns
 */
export function readFirstPath(draft: ConfigDraft, ...paths: string[]): any {
  for (const path of paths) {
    const value = readPath(draft, path);
    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }

  return undefined;
}

/**
 * Write a dotted path into a draft, making the objects on the way.
 *
 * @param draft
 * @param path
 * @param value
 */
export function writePath(draft: ConfigDraft, path: string, value: unknown) {
  const segments = path.split(".");
  const last = segments.pop();

  if (last === undefined) {
    return;
  }

  let current: any = draft;
  for (const segment of segments) {
    if (current[segment] === undefined || current[segment] === null || typeof current[segment] !== "object") {
      current[segment] = {};
    }

    current = current[segment];
  }

  // An answer left blank means "don't set this", not "set it to
  // nothing", so the key is removed rather than written empty
  if (value === undefined || value === "") {
    delete current[last];
    return;
  }

  current[last] = value;
}

// A hostname, which is what a domain and a node address both are
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;

// Deliberately forgiving: this is a sanity check, not an attempt to
// decide what a valid address is
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// A Kubernetes name, which is what a node has to be
const DNS_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Require an answer.
 *
 * @param what
 * @returns
 */
export function required(what: string) {
  return (value: string) =>
    value.trim() !== "" ? true : `Please give ${what}.`;
}

/**
 * Check something looks like an email address.
 *
 * @param value
 * @returns
 */
export function validateEmail(value: string): true | string {
  return EMAIL.test(value.trim()) ? true : "That doesn't look like an email address.";
}

/**
 * Check something looks like a hostname.
 *
 * @param value
 * @returns
 */
export function validateHostname(value: string): true | string {
  return HOSTNAME.test(value.trim())
    ? true
    : "That doesn't look like a hostname. Expected something like cloud.example.com.";
}

/**
 * Check something can be a Kubernetes node name.
 *
 * @param value
 * @returns
 */
export function validateNodeName(value: string): true | string {
  return DNS_LABEL.test(value.trim().toLowerCase())
    ? true
    : "A node name has to be lowercase letters, digits and dashes, starting and ending with a letter or digit.";
}

/**
 * Say how many of something there are, in words that read.
 *
 * @param count
 * @param singular
 * @param plural
 * @returns
 */
export function countOf(count: number, singular: string, plural?: string): string {
  const word = count === 1 ? singular : plural !== undefined ? plural : `${singular}s`;
  return `${count} ${word}`;
}

/**
 * What to show in the menu when a section has nothing yet.
 */
export const NOTHING_SET = "not set";
