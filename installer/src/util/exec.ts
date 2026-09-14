/**
 * @file
 * Running a command here, on the machine the installer is on.
 *
 * The signature is (command, stdin) rather than node's own, because
 * that's what a CommandBundle hands its execution function and it has
 * to mean the same thing whether the command runs locally or over SSH.
 */
import child_process from "node:child_process";

/**
 * What a command produced.
 */
export interface ExecResult {
  stdout: string;
  stderr: string;
}

/**
 * Run a command, optionally writing something to its standard input.
 *
 * Standard input is how anything secret gets to a command: a value on
 * a command line is visible to every user on the machine through a
 * process listing, and ends up in error messages and logs besides,
 * while what a process reads on stdin is only ever seen by that
 * process.
 *
 * Failures are reported the way child_process reports them, with the
 * command and both streams hung off the error, since that's the shape
 * every caller already reads.
 *
 * @param command
 * @param stdin
 * @returns
 */
export function exec(command: string, stdin?: string): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = child_process.exec(command, (error: any, stdout, stderr) => {
      if (error !== null) {
        error.cmd = command;
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }

      resolve({ stdout, stderr });
    });

    // A command that exits before reading all of its input (a kubectl
    // validation failure, say) breaks the pipe. The callback above
    // already reports why it exited, so the broken pipe is swallowed
    // here rather than being left to take down the process.
    child.stdin?.on("error", () => {});

    // Closed either way. A command given no input and left with an
    // open pipe waits for something that is never coming, and hanging
    // is a worse answer than reading end-of-file.
    child.stdin?.end(stdin !== undefined ? stdin : "");
  });
}

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
