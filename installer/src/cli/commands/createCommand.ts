/**
 * @file
 * Turn a command specification into the command that runs it.
 */
import Command, { CommandSpec, CommandType } from "./Command.ts";
import TerminalCommand from "./TerminalCommand.ts";
import WebCommand from "./WebCommand.ts";

/**
 * Build a command from its specification.
 *
 * A spec says which kind it is through "type", and when it doesn't
 * we go by what's in it: something with a URL is a request and
 * everything else is a shell command. That keeps the bundles that
 * were written before any of this existed working untouched.
 *
 * @param spec
 * @returns
 */
export function createCommand(spec: CommandSpec): Command {
  switch (getCommandType(spec)) {
    case CommandType.Web:
      return new WebCommand(spec as any);

    case CommandType.Terminal:
      return new TerminalCommand(spec as any);

    default:
      throw new Error(
        `Command "${spec.name}" has an unknown type "${spec.type}". Supported types are: ${Object.values(CommandType).join(", ")}.`,
      );
  }
}

/**
 * Work out which kind of command a specification describes.
 *
 * @param spec
 * @returns
 */
export function getCommandType(spec: CommandSpec): CommandType | undefined {
  if (spec.type !== undefined) {
    return spec.type;
  }

  return "url" in spec ? CommandType.Web : CommandType.Terminal;
}
