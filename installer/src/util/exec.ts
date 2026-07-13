/**
 * Use promise based exec rather than
 * having to deal with streams as for
 * the most parts streams are unecessary.
 */
import { promisify } from "node:util";
import child_process from "node:child_process";
export const exec = promisify(child_process.exec);

/**
 * Execute a command whose output is in JSON format.
 * Automatically parse and return the resulting data.
 *
 * @param command
 * @returns
 */
export async function execJson(command: string) {
  const { stdout } = await exec(command);
  const res = JSON.parse(stdout);
  return res;
}
