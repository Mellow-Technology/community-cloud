/**
 * @file
 * Modules TypeScript needs told about.
 *
 * The manifests that ship with the installer live in a SQLite
 * database compiled into the executable. Bun embeds a file imported
 * with a "file" attribute and hands back a path to read it from, so
 * an import of the database is a path, not the database itself.
 *
 * The bun:sqlite declaration covers only what's used, which avoids
 * pulling a whole set of runtime types in for one import.
 *
 * This lives under src/ rather than alongside bun-env.d.ts because
 * tsconfig only includes src/.
 */
declare module "*.sqlite" {
  const path: string;
  export default path;
}

declare module "bun:sqlite" {
  interface Statement {
    get(...parameters: unknown[]): unknown;
    all(...parameters: unknown[]): unknown[];
  }

  export class Database {
    static deserialize(contents: Uint8Array): Database;
    query(sql: string): Statement;
  }
}
