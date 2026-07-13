import RemoteHost from "../remote/RemoteHost.ts";

export enum OutputType {
  // Output is JSON
  Json = "json",

  // Output is CSV
  Csv = "csv",

  // Output is Yaml
  Yaml = "yaml",

  // Output should be handled by a specific
  // command parser
  // e.g. for instance using JC (https://github.com/kellyjonbrazil/jc)
  // for many commands
  CommandParser = "command_parser",

  // Output is handled by a custom function
  // in order to parse the output
  Custom = "custom",
}

interface CommandParams {
  name: string;
  description: string;
  command: string | Function;
  output: OutputType;
  remoteHost?: RemoteHost;
}

/**
 * A single command, can be executed locally or remotely
 */
export default class Command {
  // A human readable
  name: string;

  // A description of what the command does
  description: string;

  // The string to use for the command
  command: string | Function;

  // The raw output of the command
  rawOutput: string | null;

  // The type of output the command has
  outputType: OutputType;

  // The parsed output of the command
  // TODO: Make this a generic so that
  // each command has a verifiable output
  parsedOutput: any;

  // The function the command will be executed
  // with
  remoteHost?: RemoteHost;

  // An optional function to parse the
  // output
  parseFunction?: Function;

  // Post process hooks will be called
  // once the output has been parsed
  postProcessHooks: Function[];

  constructor({
    name,
    description,
    command,
    output,
    remoteHost = undefined,
  }: CommandParams) {
    this.name = name;
    this.description = description;
    this.command = command;
    this.outputType = output;
    this.remoteHost = remoteHost;
    this.rawOutput = null;
    this.postProcessHooks = [];
  }

  async exec(context = undefined) {
    let cmdString = null;

    // If the command is a function it's a
    // command creator, so we pass the context
    // to it to get the final command string
    if (typeof this.command === "function") {
      cmdString = this.command(context);
    } else {
      cmdString = this.command;
    }

    // Run the command string
    let res = null;
    if (this.remoteHost !== undefined) {
      res = await this.remoteHost.execJSON(cmdString);
    }

    // Run post-process hooks
    return res;
  }

  parseOutput(): any {
    if (this.rawOutput === null || this.rawOutput === undefined) {
      this.parsedOutput = null;
      return false;
    }

    try {
      switch (this.outputType) {
        case OutputType.Json:
          this.parsedOutput = JSON.parse(this.rawOutput);
          break;

        case OutputType.Csv:
          console.warn(
            "YAML parsing requires an external library (e.g., js-yaml). Returning raw output.",
          );
          this.parsedOutput = this.rawOutput;
          break;

        case OutputType.Yaml:
          // YAML parsing would require a library like js-yaml
          // For now, we'll store the raw output and note that parsing requires external dependency
          console.warn(
            "YAML parsing requires an external library (e.g., js-yaml). Returning raw output.",
          );
          this.parsedOutput = this.rawOutput;
          break;

        case OutputType.CommandParser:
          // CommandParser (e.g., JC) would require external command execution
          // This would be implemented when the execution infrastructure is ready
          console.warn(
            "CommandParser output type requires external tool (e.g., JC). Returning raw output.",
          );
          this.parsedOutput = this.rawOutput;
          break;

        case OutputType.Custom:
          if (this.parseFunction) {
            this.parsedOutput = this.parseFunction(this.rawOutput);
          } else {
            console.warn("Custom output type requires a parseFunction.");
            this.parsedOutput = this.rawOutput;
          }
          break;

        default:
          console.warn(`Unknown output type: ${this.outputType}`);
          this.parsedOutput = this.rawOutput;
      }
    } catch (error) {
      console.error(`Failed to parse ${this.outputType} output:`, error);
      this.parsedOutput = null;
      return false;
    }

    return true;
  }
}
