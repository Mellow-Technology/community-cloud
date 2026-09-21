/**
 * @file
 * A plugin that's still a directory.
 *
 * This is the form a plugin has while someone is writing it, and the
 * reason it exists alongside the packaged form is authorship: having
 * to rebuild an archive after every edit would make packaging a tax
 * on writing a plugin rather than a convenience for sending one.
 *
 * It's also the simplest possible implementation of the interface,
 * which makes it the right one to build everything else against.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import {
  PluginSource,
  missingFileError,
  normalisePluginPath,
} from "./PluginSource.ts";

export default class DirectorySource implements PluginSource {
  origin: string;

  // The listing, read once. A plugin doesn't change under us during a
  // run, and walking the tree for every template would be wasteful.
  private files: string[] | undefined;

  constructor(directory: string) {
    this.origin = directory;
  }

  /**
   * Every file in the plugin, as relative paths with forward slashes.
   *
   * @returns
   */
  list(): string[] {
    if (this.files === undefined) {
      this.files = walk(this.origin, this.origin).sort();
    }

    return this.files;
  }

  /**
   * @param path
   * @returns
   */
  has(path: string): boolean {
    try {
      return this.list().includes(normalisePluginPath(path, this.origin));
    } catch {
      return false;
    }
  }

  /**
   * @param path
   * @returns
   */
  read(path: string): Uint8Array {
    const wanted = normalisePluginPath(path, this.origin);

    if (!this.list().includes(wanted)) {
      throw missingFileError(wanted, this);
    }

    // Read through the listing rather than joining the caller's path
    // directly: the listing holds only things actually inside the
    // directory, so a symlink pointing out of it was already dropped
    return new Uint8Array(readFileSync(join(this.origin, ...wanted.split("/"))));
  }

  /**
   * @param path
   * @returns
   */
  readText(path: string): string {
    return new TextDecoder().decode(this.read(path));
  }
}

/**
 * Every ordinary file under a directory, relative to the root.
 *
 * Symlinks are not followed and not listed. A plugin is meant to be
 * self-contained, and a link is either pointing at something inside it
 * — in which case the target is already listed — or at something
 * outside it, which it shouldn't be reaching for.
 *
 * @param directory
 * @param root
 * @returns
 */
function walk(directory: string, root: string): string[] {
  let entries;

  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error: any) {
    throw new Error(`Couldn't read the plugin directory ${directory}: ${error.message}`);
  }

  const files: string[] = [];

  for (const entry of entries) {
    // isFile() and isDirectory() are both false for a symlink here,
    // since withFileTypes doesn't follow them
    if (entry.isDirectory()) {
      files.push(...walk(join(directory, entry.name), root));
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    files.push(relative(root, join(directory, entry.name)).split(sep).join("/"));
  }

  return files;
}

/**
 * Whether a path looks like an unpacked plugin.
 *
 * @param directory
 * @returns
 */
export function looksLikePlugin(directory: string): boolean {
  try {
    return statSync(join(directory, "plugin.yaml")).isFile();
  } catch {
    return false;
  }
}
