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

/**
 * How to write a file.
 *
 * - mode: the permissions it ends up with. The default is what an
 *   ordinary configuration file wants; anything holding a credential
 *   should say 0600.
 * - asRoot: whether the file belongs to root. Needed for anywhere
 *   under /etc, and for anything only a service should read.
 */
export interface WriteFileOptions {
  mode?: string;
  asRoot?: boolean;
}

/**
 * Build a command that writes a file from its standard input.
 *
 * The contents go over standard input rather than into the command,
 * which is what keeps a password out of a process listing and a whole
 * YAML document out of a shell quoting problem. The caller supplies
 * them as the command's "stdin".
 *
 * The file is created empty with its permissions already set, then
 * written into. Setting them afterwards leaves a window where the
 * contents are on disk and readable by everyone, which for the files
 * this is used for is the entire problem.
 *
 * sudo goes on each part rather than on the command as a whole,
 * because the privileged half is the write at the end of a pipe: a
 * leading sudo would leave the redirect running as the connecting
 * user. That's also why a command using this doesn't set the sudo
 * flag.
 *
 * @param filePath
 * @param options
 * @returns the lines of the command
 */
export function writeFileCommand(
  filePath: string,
  options: WriteFileOptions = {},
): string[] {
  const { mode = "0644", asRoot = false } = options;

  const sudo = asRoot ? "sudo " : "";
  const ownership = asRoot ? "-o root -g root " : "";
  const quotedPath = quoteForShell(filePath);

  return [
    `${sudo}install ${ownership}-m ${mode} /dev/null ${quotedPath} || { echo "Couldn't create ${filePath}" >&2; exit 1; }`,
    `${sudo}tee ${quotedPath} > /dev/null || { echo "Couldn't write ${filePath}" >&2; exit 1; }`,
  ];
}

/**
 * Poll a check until it passes, or until we've waited long enough.
 *
 * Written as one loop rather than joined with the commands around it,
 * since "do" takes the body straight after it with no separator.
 *
 * A wait of nothing produces a command that does nothing, so a caller
 * with no patience gets a command with no loop in it rather than a
 * loop that runs once.
 *
 * @param check
 * @param seconds
 * @returns
 */
export function waitUntil(check: string, seconds: number): string {
  if (seconds <= 0) {
    return "true";
  }

  return `for attempt in $(seq ${seconds}); do ${check} && break; sleep 1; done`;
}

/**
 * How long a command should be prepared to wait.
 *
 * Every wait in here exists for the same reason: directly after a
 * change, the thing being checked may not have caught up yet. An
 * agent has its certificate before the API server has a Node for it,
 * a pool is accepted a moment after it's created. Waiting is right
 * there, and wrong everywhere else — something only asking what is
 * currently true has no race to lose, and a node with a real problem
 * would make it sit through every timeout in turn before saying so.
 *
 * So the patience comes from the context, and anything that just
 * wants an answer says it has none.
 *
 * @param context
 * @param fallback what to wait when nothing says otherwise
 * @returns
 */
export function getWaitSeconds(context: any, fallback: number): number {
  return context !== undefined && context !== null && context.noWaiting === true
    ? 0
    : fallback;
}
