/**
 * @file
 * The manifests and values files that ship inside the installer.
 *
 * These live in a SQLite database compiled into the executable, so a
 * released binary can apply the manifests it was built with on a
 * machine that has never seen this repository.
 *
 * They're referred to with an "embed://" URL, which is what tells the
 * installer to look inside itself rather than on disk:
 *
 *   embed://certs/ClusterIssuer.yaml     the copy in the binary
 *   ./ops/my-template.yaml               a file on this machine
 *
 * The paths have no "k8s/" prefix. That directory exists to keep the
 * repository tidy and is no use to anyone typing a path.
 */
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";

import databaseFile from "../generated/embedded.sqlite" with { type: "file" };

/**
 * The database, opened the first time something asks for it.
 *
 * It arrives as an embedded file rather than through an import with a
 * "sqlite" attribute: that form works when running from source, but
 * "bun build --compile" doesn't carry it into an executable, so the
 * bytes are embedded and handed to SQLite in memory instead. All 78KB
 * of it, which is not worth reading on a command that never asks.
 */
let database: Database | undefined = undefined;

/**
 * @returns the embedded database
 */
function getDatabase(): Database {
  if (database === undefined) {
    database = Database.deserialize(readFileSync(databaseFile));
  }

  return database;
}

/**
 * What marks a path as one of ours.
 */
export const EMBED_SCHEME = "embed://";

/**
 * Whether a path refers to a file inside the installer.
 *
 * @param path
 * @returns
 */
export function isEmbeddedPath(path: string): boolean {
  return path.startsWith(EMBED_SCHEME);
}

/**
 * Turn an embed:// URL into the path stored in the database.
 *
 * Tolerates a leading slash or a "k8s/" prefix, since both are easy
 * things to type and neither is wrong in spirit.
 *
 * @param path
 * @returns
 */
export function toEmbeddedPath(path: string): string {
  const withoutScheme = isEmbeddedPath(path) ? path.slice(EMBED_SCHEME.length) : path;

  return withoutScheme.replace(/^\/+/, "").replace(/^k8s\//, "");
}

/**
 * Read a file that ships with the installer.
 *
 * @param path an embed:// URL, or the path within it
 * @returns
 */
export function readEmbeddedFile(path: string): string {
  const wanted = toEmbeddedPath(path);

  const row = getDatabase()
    .query("SELECT contents FROM files WHERE path = ?")
    .get(wanted) as { contents: string } | null;

  if (row === null || row === undefined) {
    throw new Error(
      `"${path}" isn't one of the files that ships with the installer.${suggest(wanted)}`,
    );
  }

  return row.contents;
}

/**
 * Whether a file ships with the installer.
 *
 * @param path
 * @returns
 */
export function hasEmbeddedFile(path: string): boolean {
  const row = getDatabase()
    .query("SELECT 1 FROM files WHERE path = ?")
    .get(toEmbeddedPath(path)) as unknown;

  return row !== null && row !== undefined;
}

/**
 * Every file that ships with the installer.
 *
 * @returns
 */
export function listEmbeddedFiles(): string[] {
  const rows = getDatabase().query("SELECT path FROM files ORDER BY path").all() as {
    path: string;
  }[];

  return rows.map((row) => row.path);
}

/**
 * Point at something close to what was asked for.
 *
 * Typing one of these by hand is easy to get slightly wrong, and a
 * list of everything would be 44 lines, so this offers the ones
 * sharing a directory or a name.
 *
 * @param wanted
 * @returns
 */
function suggest(wanted: string): string {
  const name = wanted.split("/").pop();
  const directory = wanted.includes("/") ? wanted.slice(0, wanted.lastIndexOf("/")) : "";

  const near = listEmbeddedFiles().filter(
    (path) =>
      (directory !== "" && path.startsWith(`${directory}/`)) ||
      (name !== undefined && name !== "" && path.toLowerCase().includes(name.toLowerCase())),
  );

  if (near.length === 0) {
    return " Run \"list-embedded\" to see what does.";
  }

  return ` Did you mean one of these?\n  ${near.map((path) => `${EMBED_SCHEME}${path}`).join("\n  ")}`;
}
