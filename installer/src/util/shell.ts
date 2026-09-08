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
