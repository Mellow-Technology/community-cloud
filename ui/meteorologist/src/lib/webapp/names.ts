/**
 * @file
 * The names Cirrus gives what it makes for an application in a shared
 * service, as operators/cirrus/src/naming.rs gives them, so they can be
 * shown without asking for objects a person, or an agent, may not be
 * allowed to read. Change the two together.
 */
import { createHash } from "node:crypto";

// Kubernetes's longest name, and how much of a hash a cut name keeps
const MAX_NAME = 63;
const HASH_LENGTH = 8;

/**
 * A name of at most 63 characters: as it is, or cut short with a hash
 * of the whole, so two long names don't come out the same.
 *
 * @param name
 * @returns
 */
function fit(name: string): string {
  if (name.length <= MAX_NAME) return name;
  const hash = createHash("sha256").update(name).digest("hex").slice(0, HASH_LENGTH);
  const prefix = name.slice(0, MAX_NAME - HASH_LENGTH - 1).replace(/-+$/, "");
  return `${prefix}-${hash}`;
}

/**
 * The name of what's made for an application in a shared service, such
 * as its bucket in SeaweedFS: Cirrus's shared_name.
 *
 * @param namespace
 * @param app
 * @returns
 */
export function sharedName(namespace: string, app: string): string {
  return fit(`${namespace}-${app}`);
}
