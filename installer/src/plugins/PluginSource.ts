/**
 * @file
 * Where a plugin's files come from.
 *
 * A plugin is a directory while it's being written and one file when
 * it's being handed to somebody, and nothing above this layer should
 * have to know which it's looking at. So both answer the same three
 * questions — what's in you, is this in you, give me this — and the
 * resolver, the manifest reader and the template renderer all work
 * the same way either side of packaging.
 *
 * That also means the archive format is a decision that can be
 * changed later without touching anything else, which is the point:
 * there is a real argument for zip and a real argument for gzipped
 * tar, and this is the seam that makes it not matter very much.
 *
 * Paths inside a source are always relative and always use forward
 * slashes, whatever the platform, because they're written into
 * plugin.yaml by a person who may be on a different one.
 */

/**
 * A plugin's files, however they're stored.
 */
export interface PluginSource {
  // Where this came from, for error messages. A directory path or an
  // archive path — never shown as the plugin's name, which comes from
  // the manifest.
  origin: string;

  // Every file in the plugin, as relative paths
  list(): string[];

  // Whether a path is in the plugin
  has(path: string): boolean;

  // A file's bytes
  read(path: string): Uint8Array;

  // A file as text, which is what everything here actually wants
  readText(path: string): string;
}

/**
 * Normalise a path as written in a manifest into the form a source
 * stores.
 *
 * The interesting part is what this refuses. A plugin names its own
 * files, and a plugin that names "../../../etc/passwd" is either
 * broken or hostile; either way it shouldn't be answered. Escaping
 * the plugin is rejected here, once, rather than in each source —
 * a directory source would otherwise happily walk out of its own
 * directory, which is exactly the bug this exists to not have.
 *
 * @param path
 * @param origin what to name in the error
 * @returns
 */
export function normalisePluginPath(path: string, origin: string): string {
  const cleaned = path.replace(/\\/g, "/").replace(/^\/+/, "");
  const parts: string[] = [];

  for (const part of cleaned.split("/")) {
    if (part === "" || part === ".") {
      continue;
    }

    if (part === "..") {
      throw new Error(
        `"${path}" points outside the plugin at ${origin}. A plugin can only name files inside itself.`,
      );
    }

    parts.push(part);
  }

  if (parts.length === 0) {
    throw new Error(`"${path}" doesn't name a file in the plugin at ${origin}.`);
  }

  return parts.join("/");
}

/**
 * Say a file isn't there, and suggest what might have been meant.
 *
 * A plugin is a small enough thing that listing what it does have is
 * more useful than a bare failure, and the common case is a typo or a
 * file that didn't get packaged.
 *
 * @param path
 * @param source
 * @returns
 */
export function missingFileError(path: string, source: PluginSource): Error {
  const files = source.list();
  const near = files.filter((entry) => entry.endsWith(path.split("/").pop() ?? ""));
  const shown = (near.length > 0 ? near : files).slice(0, 8);

  return new Error(
    `The plugin at ${source.origin} has no "${path}".${
      shown.length > 0 ? ` It does have:\n  ${shown.join("\n  ")}` : " It has no files at all."
    }`,
  );
}
