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

/**
 * Build an exec function which writes `input` to the stdin of
 * whatever command it's given.
 *
 * The returned function takes the same single command string that
 * `exec` does so that it can be handed straight to a CommandBundle,
 * which only ever supplies the command itself.
 *
 * @param input
 * @returns
 */
export function execWithInput(input: string) {
  return (command: string) =>
    new Promise((resolve, reject) => {
      const child = child_process.exec(command, (error, stdout, stderr) => {
        if (error) {
          // Commands report failures through the error, so we
          // carry the output across for the caller to log
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
          return;
        }

        resolve({ stdout, stderr });
      });

      // A command that exits before reading all of its input
      // (a kubectl validation failure, say) breaks the pipe. The
      // callback above already reports that, so we swallow it here
      // rather than let it take down the process.
      child.stdin?.on("error", () => {});
      child.stdin?.end(input);
    });
}
