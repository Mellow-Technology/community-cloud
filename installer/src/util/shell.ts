/**
 * @file
 * Helpers for building shell commands.
 */

// A shell variable name, which is what an environment variable
// assignment has to look like before it goes into a command
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Single quote a value for the shell.
 *
 * Single quotes take everything literally, so the only thing needing
 * care is a single quote in the value itself: close the quoting, emit
 * an escaped quote, and open it again.
 *
 * @param value
 * @returns
 */
export function quoteForShell(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Turn a set of environment variables into shell assignments.
 *
 * Values are quoted, and anything left unset is dropped so that a
 * caller can hand over optional settings without picking through them
 * first.
 *
 * @param env
 * @returns
 */
export function formatEnvAssignments(env: Record<string, unknown>): string[] {
  return Object.entries(env)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([name, value]) => {
      if (!ENV_NAME.test(name)) {
        throw new Error(
          `"${name}" isn't a valid environment variable name. Expected letters, digits and underscores, not starting with a digit.`,
        );
      }

      return `${name}=${quoteForShell(String(value))}`;
    });
}

/**
 * A command's secret environment, split into the part that goes into
 * the command and the part that goes over standard input.
 */
export interface SecretEnvScript {
  preamble: string;
  payload: string;
}

/**
 * Build the shell that reads secret environment variables from
 * standard input and exports them.
 *
 * Ordinary variables are written into the command as assignments,
 * which is fine for a version number and wrong for a cluster token:
 * everything a process was started with is visible to every user on
 * the machine through a process listing, and gets quoted back in any
 * error the command produces. These arrive on standard input instead,
 * where only the shell reading them ever sees them.
 *
 * Values have to be single lines, since that's what makes the reading
 * loop a loop rather than a parser. Anything with a newline in it is a
 * document rather than a setting, and belongs on "stdin" instead.
 *
 * @param env
 * @param commandName used to say which command a bad value came from
 * @returns the preamble and the payload, or undefined when there are
 *          no secrets to pass
 */
export function buildSecretEnvScript(
  env: Record<string, unknown>,
  commandName: string,
): SecretEnvScript | undefined {
  const lines: string[] = [];

  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }

    if (!ENV_NAME.test(name)) {
      throw new Error(
        `"${name}" isn't a valid environment variable name. Expected letters, digits and underscores, not starting with a digit.`,
      );
    }

    const text = String(value);
    if (text.includes("\n")) {
      throw new Error(
        `The secret "${name}" in the command "${commandName}" runs over more than one line, and secret environment variables have to be single lines. Pass it on "stdin" instead.`,
      );
    }

    lines.push(`${name}=${text}`);
  }

  if (lines.length === 0) {
    return undefined;
  }

  return {
    // Reads to end of input, so this can't be combined with a command
    // that wants standard input for itself. "export" takes a
    // name=value operand, which is what keeps the value out of the
    // command's own arguments.
    preamble: [
      "while IFS= read -r __cc_secret",
      "do",
      '  [ -n "$__cc_secret" ] || continue',
      '  export "$__cc_secret"',
      "done",
      "unset __cc_secret",
    ].join("\n"),

    // The trailing newline matters: "read" only returns a line once it
    // has seen the end of one
    payload: `${lines.join("\n")}\n`,
  };
}
