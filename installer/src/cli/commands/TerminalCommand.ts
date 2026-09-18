/**
 * @file
 * A command that runs in a shell, either locally or on a node over SSH.
 *
 * This is what a bundle holds unless it says otherwise, and it's the
 * original Command: everything about building a command string, its
 * environment and its privileges lives here, while parsing the output
 * and passing values on belongs to the base class.
 */
import Command, {
  CommandContext,
  CommandOutput,
  CommandResults,
  OutputType,
  TerminalCommandSpec,
  joinCommand,
} from "./Command.ts";
import CloudConfig from "../../util/CloudConfig.ts";
import {
  SecretEnvScript,
  buildSecretEnvScript,
  formatEnvAssignments,
} from "../../util/shell.ts";
import { exec } from "../../util/exec.ts";

export default class TerminalCommand extends Command {
  // The command itself. An array is taken as the lines of a script.
  command: string | string[] | Function;

  // The function to execute the command with
  execFunction: Function;

  // Whether the command should be run using sudo
  sudo: boolean;

  // Environment variables for the command. Either a plain object or a
  // function which is handed the same arguments as a command creator
  // and returns one, for variables that depend on the configuration.
  env?: Record<string, string> | Function;

  // What to write to the command's standard input, either a string or
  // a function which builds one
  stdin?: string | Function;

  // Environment variables which mustn't appear on the command line.
  // They go over standard input instead.
  secretEnv?: Record<string, unknown> | Function;

  // The host the command will be executed on
  remoteHost?: unknown;

  constructor(spec: TerminalCommandSpec) {
    super(spec, OutputType.Raw);

    const {
      command,
      sudo = false,
      env = undefined,
      stdin = undefined,
      secretEnv = undefined,
      remoteHost = undefined,
    } = spec;

    this.command = command;
    this.sudo = sudo;
    this.env = env;
    this.stdin = stdin;
    this.secretEnv = secretEnv;
    this.remoteHost = remoteHost;
    this.execFunction = exec;
  }

  /**
   * Set the execution function.
   * @param execFunction
   */
  setExecFunction(execFunction: Function) {
    this.execFunction = execFunction;
  }

  /**
   * Build the command string and run it.
   *
   * @param config
   * @param context
   * @param commandResults
   * @returns
   */
  protected async run(
    config: CloudConfig,
    context: CommandContext,
    commandResults: CommandResults,
  ): Promise<CommandOutput> {
    // If the command is a function it's a
    // command creator, so we pass the context
    // to it to get the final command string
    const built =
      typeof this.command === "function"
        ? this.command(config, context, commandResults)
        : this.command;

    // Either form can be an array of lines, a builder included, since
    // a command put together from the configuration is the one most
    // likely to be assembled a piece at a time
    let cmdString = joinCommand(built);

    // Work out the environment for the command, which can be a plain
    // object or, like the command itself, something derived from the
    // configuration
    const assignments = formatEnvAssignments(
      this.resolveEnv(config, context, commandResults),
    );

    // If we're running with sudo then
    // we prepend sudo to the command
    if (this.sudo) {
      // One sudo in front of a script only elevates its first line.
      // The rest run as the connecting user, which mostly looks like
      // working until something needs root and doesn't say so. A
      // script that needs root says so on each line that does.
      if (cmdString.includes("\n")) {
        throw new Error(
          `The command "${this.name}" sets "sudo" and is more than one line. A leading sudo only applies to the first of them, so put sudo on each line that needs it instead.`,
        );
      }

      // sudo clears the environment it was given, so the variables go
      // through env rather than being exported ahead of it
      cmdString =
        assignments.length > 0
          ? `sudo env ${assignments.join(" ")} ${cmdString}`
          : `sudo ${cmdString}`;
    }
    else if (assignments.length > 0) {
      // Exported rather than written as a prefix so that everything
      // the command runs sees them, including the far side of a pipe.
      // "curl ... | sh -" is the reason this matters: a prefix would
      // only reach curl.
      cmdString = `export ${assignments.join(" ")}; ${cmdString}`;
    }

    // If a command parser is specified then
    // we pipe the contents of the command
    // through the command parser
    if (this.commandParser !== undefined) {
      cmdString += ` | ${this.commandParser}`;
    }

    // Anything secret travels on standard input rather than in the
    // command string, so a process listing on the node, and any error
    // quoting the command back, show the shape of the command without
    // its credentials
    let stdin = this.resolveStdin(config, context, commandResults);
    const secrets = this.buildSecretEnv(config, context, commandResults);

    if (secrets !== undefined) {
      if (stdin !== undefined) {
        throw new Error(
          `The command "${this.name}" sets both "stdin" and "secretEnv", and a command only has one standard input. Read the secrets into the command itself, or pass them as ordinary "env".`,
        );
      }

      cmdString = `${secrets.preamble}\n${cmdString}`;
      stdin = secrets.payload;
    }

    // Run the function
    return await this.execFunction(cmdString, stdin);
  }

  /**
   * Work out what to write to the command's standard input.
   *
   * @param config
   * @param context
   * @param commandResults
   * @returns
   */
  resolveStdin(config: any, context: any, commandResults: any): string | undefined {
    if (this.stdin === undefined || this.stdin === null) {
      return undefined;
    }

    const stdin =
      typeof this.stdin === "function"
        ? this.stdin(config, context, commandResults)
        : this.stdin;

    return stdin !== undefined && stdin !== null ? String(stdin) : undefined;
  }

  /**
   * Work out the secret environment for this command.
   *
   * sudo is refused rather than worked around: it throws away the
   * environment it was given, and the only way to put a variable back
   * is to name it in sudo's own arguments, which is the command line
   * these are here to stay out of. A command needing both should read
   * what it needs from standard input and hand it to sudo itself.
   *
   * @param config
   * @param context
   * @param commandResults
   * @returns
   */
  buildSecretEnv(
    config: any,
    context: any,
    commandResults: any,
  ): SecretEnvScript | undefined {
    if (this.secretEnv === undefined || this.secretEnv === null) {
      return undefined;
    }

    if (this.sudo) {
      throw new Error(
        `The command "${this.name}" sets both "sudo" and "secretEnv". sudo clears the environment, so the values would have to be named in its arguments, which is the command line they're meant to stay off.`,
      );
    }

    const secretEnv =
      typeof this.secretEnv === "function"
        ? this.secretEnv(config, context, commandResults)
        : this.secretEnv;

    if (secretEnv === undefined || secretEnv === null) {
      return undefined;
    }

    return buildSecretEnvScript(secretEnv, this.name);
  }

  /**
   * Work out the environment variables for this command.
   *
   * @param config
   * @param context
   * @param commandResults
   * @returns
   */
  resolveEnv(
    config: CloudConfig,
    context: CommandContext,
    commandResults: CommandResults,
  ): Record<string, unknown> {
    if (this.env === undefined || this.env === null) {
      return {};
    }

    const env =
      typeof this.env === "function"
        ? this.env(config, context, commandResults)
        : this.env;

    return env !== undefined && env !== null ? env : {};
  }
}
