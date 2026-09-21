/**
 * @file
 * A plugin that's one file.
 *
 * This is the form a plugin has when it's being handed to somebody: a
 * single artefact to attach to a release, check a hash against, and
 * send. The extension is ".ccp" and the contents are an ordinary zip,
 * which means every tool anyone already has still opens it.
 *
 * Nothing is unpacked. The whole archive is read once and kept in
 * memory, templates are handed out of it as they're asked for, and
 * there is no cache directory to invalidate, no temporary files to
 * clean up, and nothing left on disk if the process stops halfway.
 * A plugin is a few tens of kilobytes of YAML; this is cheaper than
 * the bookkeeping that unpacking would need.
 */
import { readFileSync } from "node:fs";

import {
  PluginSource,
  missingFileError,
  normalisePluginPath,
} from "./PluginSource.ts";
import { readZip } from "./zip.ts";

// What a packaged plugin is called. A Community Cloud Plugin, and a
// zip file under another name.
export const PLUGIN_EXTENSION = ".ccp";

export default class ArchiveSource implements PluginSource {
  origin: string;

  private entries: Map<string, Uint8Array>;

  constructor(path: string, bytes?: Uint8Array) {
    this.origin = path;

    const contents = bytes !== undefined ? bytes : new Uint8Array(readFileSync(path));
    this.entries = new Map();

    for (const entry of readZip(contents, path)) {
      // Normalised on the way in, so that an archive built on Windows
      // and one built on a Mac answer the same questions
      const path = entry.path.replace(/\\/g, "/").replace(/^\.\//, "");
      this.entries.set(path, entry.contents);
    }
  }

  /**
   * @returns
   */
  list(): string[] {
    return [...this.entries.keys()].sort();
  }

  /**
   * @param path
   * @returns
   */
  has(path: string): boolean {
    try {
      return this.entries.has(normalisePluginPath(path, this.origin));
    } catch {
      return false;
    }
  }

  /**
   * @param path
   * @returns
   */
  read(path: string): Uint8Array {
    const found = this.entries.get(normalisePluginPath(path, this.origin));

    if (found === undefined) {
      throw missingFileError(path, this);
    }

    return found;
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
 * Whether a filename looks like a packaged plugin.
 *
 * @param path
 * @returns
 */
export function looksLikeArchive(path: string): boolean {
  return path.toLowerCase().endsWith(PLUGIN_EXTENSION);
}
