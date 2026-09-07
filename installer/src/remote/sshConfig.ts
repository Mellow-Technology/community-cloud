/**
 * @file
 * Look up what OpenSSH would do with a host name.
 *
 * Node addresses in a Community Cloud configuration are the names
 * people already use for their machines ("phoenix", "guandi"), and
 * those are usually aliases defined in ~/.ssh/config rather than names
 * DNS can resolve. ssh2 knows nothing about that file, so a node that
 * "ssh <name>" reaches happily is unreachable from here.
 *
 * Rather than reimplement the config format, with its globs, Match
 * blocks and Includes, we ask ssh itself: "ssh -G <host>" prints the
 * fully resolved settings for a host and connects to nothing.
 */
import { access } from "node:fs/promises";
import { exec } from "node:child_process";
import { homedir } from "node:os";
import { promisify } from "node:util";

const execAsync = promisify(exec);

// The settings we care about out of everything ssh reports.
// ssh names a setting once, apart from identityfile which it repeats
// for every candidate key, so that one is collected as a list.
const RESOLVED_SETTINGS = ["hostname", "user", "port"];
const IDENTITY_FILE = "identityfile";

export interface ResolvedSshHost {
  host?: string;
  username?: string;
  port?: number;
  keyFile?: string;
}

/**
 * Resolve a host through the local ssh configuration.
 *
 * Anything we can't work out is left out of the result, so a caller
 * can layer its own values over the top and fall back to what it
 * already had. A machine without ssh installed, or a host ssh has
 * nothing to say about, gets an empty result rather than an error.
 *
 * @param options connection options carrying the host to resolve
 * @returns
 */
export async function resolveSshHost(options: {
  host?: string;
}): Promise<ResolvedSshHost> {
  const { host } = options;
  if (host === undefined || host === "") {
    return {};
  }

  let stdout = "";
  try {
    ({ stdout } = await execAsync(`ssh -G ${quoteForShell(host)}`));
  } catch {
    // No ssh, or it couldn't make sense of the host. Either way we
    // have nothing to add and the caller's own values still stand.
    return {};
  }

  const { identityfile, ...settings } = parseSshSettings(stdout);
  const resolved: ResolvedSshHost = {};

  // ssh always reports a hostname, echoing the name back when the
  // config says nothing about it, so this is safe either way
  if (settings.hostname !== undefined) {
    resolved.host = settings.hostname;
  }

  if (settings.user !== undefined) {
    resolved.username = settings.user;
  }

  if (settings.port !== undefined) {
    const port = Number.parseInt(settings.port, 10);
    if (!Number.isNaN(port)) {
      resolved.port = port;
    }
  }

  // ssh lists every candidate identity file, and most of them are
  // defaults it would try rather than anything the config asked for.
  // Only offer one we can actually read, otherwise we'd hand the
  // caller a path that doesn't exist and turn a working agent or
  // default key connection into a failure.
  const keyFile = await findReadableKey(identityfile);
  if (keyFile !== undefined) {
    resolved.keyFile = keyFile;
  }

  return resolved;
}

/**
 * Pick the first identity file that's actually on disk.
 *
 * @param paths
 * @returns
 */
async function findReadableKey(paths: string[]): Promise<string | undefined> {
  for (const path of paths) {
    const expanded = expandHome(path);

    try {
      await access(expanded);
      return expanded;
    } catch {
      continue;
    }
  }

  return undefined;
}

/**
 * Pull the settings we care about out of "ssh -G" output, which is a
 * line per setting as "name value".
 *
 * @param output
 * @returns
 */
function parseSshSettings(output: string) {
  const settings: Record<string, string> = {};
  const identityfile: string[] = [];

  for (const line of output.split("\n")) {
    const separator = line.indexOf(" ");
    if (separator === -1) {
      continue;
    }

    const name = line.slice(0, separator).toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (name === IDENTITY_FILE) {
      identityfile.push(value);
      continue;
    }

    // Settings can be reported more than once. First one wins, which
    // is the same precedence ssh itself applies.
    if (RESOLVED_SETTINGS.includes(name) && settings[name] === undefined) {
      settings[name] = value;
    }
  }

  return { ...settings, identityfile };
}

/**
 * ssh reports paths with a leading "~" left in place, which nothing
 * further down the line will expand for us.
 *
 * @param path
 * @returns
 */
function expandHome(path: string): string {
  return path.startsWith("~") ? `${homedir()}${path.slice(1)}` : path;
}

/**
 * Single quote a value for the shell.
 *
 * @param value
 * @returns
 */
function quoteForShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
