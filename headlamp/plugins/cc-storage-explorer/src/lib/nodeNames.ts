/**
 * @file
 * Giving React a stable dependency for a set of node names.
 *
 * Several hooks here take the names of the cluster's nodes and want to
 * do their work again when that set changes. Passing the array itself
 * does not do that: a fresh array is built on every render, so an
 * effect depending on it fires on every render, and a polling effect
 * built that way never settles.
 *
 * So the names are joined into one string, which compares by value,
 * and split apart again on the other side. A space is the separator
 * because a node name is a DNS subdomain and cannot contain one, so
 * nothing is lost in the round trip.
 */

// What separates the names inside a key.
const NAME_SEPARATOR = ' ';

/**
 * One comparable key for a set of node names.
 *
 * @param nodeNames
 * @returns
 */
export function buildNodeKey(nodeNames: string[]): string {
  return nodeNames.join(NAME_SEPARATOR);
}

/**
 * The names a key is made of.
 *
 * @param key
 * @returns
 */
export function readNodeKey(key: string): string[] {
  return key.split(NAME_SEPARATOR).filter(name => name !== '');
}
