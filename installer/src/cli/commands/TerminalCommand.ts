/**
 * @file
 * A command that runs in a shell, either locally or on a node over SSH.
 *
 * This is what a bundle holds unless it says otherwise, and it's the
 * original Command: everything about building a command string, its
 * environment and its privileges lives here, while parsing the output
 * and passing values on belongs to the base class.
 */
import { promisify } from "node:util";
import child_process from "node:child_process";

import Command, {
  CommandOutput,
  OutputType,
  TerminalCommandSpec,
} from "./Command.ts";
import { formatEnvAssignments } from "../../util/shell.ts";

// Use a promise-based exec
const exec = promisify(child_process.exec);

export default class TerminalCommand extends Command {
  // The string to use for the command
  command: string | Function;

  // The function to execute the command with
  execFunction: Function;

  // Whether the command should be run using sudo
  sudo: boolean;

  // Environment variables for the command. Either a plain object or a
  // function which is handed the same arguments as a command creator
  // and returns one, for variables that depend on the configuration.
  env?: Record<string, string> | Function;

  // The host the command will be executed on
  remoteHost?: unknown;

  constructor(spec: TerminalCommandSpec) {
    super(spec, OutputType.Raw);

    const { command, sudo = false, env = undefined, remoteHost = undefined } = spec;

    this.command = command;
    this.sudo = sudo;
    this.env = env;
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
  protected async run(config, context, commandResults): Promise<CommandOutput> {
    let cmdString = null;

    // If the command is a function it's a
    // command creator, so we pass the context
    // to it to get the final command string
    if (typeof this.command === "function") {
      cmdString = this.command(config, context, commandResults);
    } else {
      cmdString = this.command;
    }

    // Work out the environment for the command, which can be a plain
    // object or, like the command itself, something derived from the
    // configuration
    const assignments = formatEnvAssignments(
      this.resolveEnv(config, context, commandResults),
    );

    // If we're running with sudo then
    // we prepend sudo to the command
    if (this.sudo) {
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

    // Run the function
    return await this.execFunction(cmdString);
  }

  /**
   * Work out the environment variables for this command.
   *
   * @param config
   * @param context
   * @param commandResults
   * @returns
   */
  resolveEnv(config, context, commandResults): Record<string, unknown> {
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
