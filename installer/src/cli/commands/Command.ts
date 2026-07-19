// import RemoteHost from "../remote/RemoteHost.ts";
import { promisify } from 'node:util';
import child_process from "node:child_process";
import { loadAll } from 'js-yaml'

// import consumers from "stream/consumers";

// Use a promise-based exec
const exec = promisify(child_process.exec);

export enum OutputType {
  // Output is JSON
  Json = "json",

  // Output is CSV
  Csv = "csv",

  // Output is Yaml
  Yaml = "yaml",

  // Output is handled by a custom function
  // in order to parse the output
  Custom = "custom",

  // Raw output will short-circuit any parsing
  Raw = "raw"
}

/**
 *
 */
export interface CommandOutput {
  stdout: string | null;
  stderr: string | null;
  parsed?: any;
  processed?: any;
}

/**
 * The specification for a command.
 *
 * Each command has a
 * - name: a label for the command
 * - description: a description to show the user what the command does
 * - env: environment variables for the command
 * - command: the command itself
 * - output: an output type that will be automatically parsed
 */
export interface CommandSpec {
  name: string;
  description: string;
  command: string | Function;
  output: OutputType;
  sudo?: boolean;
  commandParser?: string;
  env?: Record<string, string> | Function;
  postProcessHooks?: Function[];
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
  rawOutput: CommandOutput | null;

  // The type of output the command has
  outputType: OutputType;

  // The function to execute the
  // command with
  execFunction: Function;

  // The parsed output of the command
  // TODO: Make this a generic so that
  // each command has a verifiable output
  parsedOutput: CommandOutput;

  // Whether the command should be run using sudo
  sudo: boolean;

  // An optional program used to process the
  // output of a command before parsing
  // e.g. for using JC (https://github.com/kellyjonbrazil/jc)
  commandParser?: string;

  // An array of functionas that can be used to post-process
  // data from a command after parsing. Processed data is
  // placed in the "process" key of the CommandOutput
  postProcessHooks?: Function[];

  // The function the command will be executed
  // with
  remoteHost?: RemoteHost;

  // An optional function to parse the
  // output
  parseFunction?: Function;

  constructor({
    name,
    description,
    command,
    output,
    commandParser = undefined,
    sudo = false,
    postProcessHooks = undefined,
    remoteHost = undefined,
  }: CommandSpec) {
    this.name = name;
    this.description = description;
    this.command = command;
    this.outputType = output;
    this.commandParser = commandParser;
    this.sudo = sudo;
    this.postProcessHooks = postProcessHooks;
    this.remoteHost = remoteHost;
    this.rawOutput = null;
    this.execFunction = exec;
    this.parsedOutput = {
      stdout: null,
      stderr: null,
      parsed: null
    }
  }


  /**
   * Set the execution function.
   * @param execFunction
   */
  setExecFunction(execFunction: Function) {
    this.execFunction = execFunction;
  }

  /**
   * Execute a command
   * @param config
   * @returns
   */
  async exec(config, commandResults, context) {
    let cmdString = null;

    // If the command is a function it's a
    // command creator, so we pass the context
    // to it to get the final command string
    if (typeof this.command === "function") {
      cmdString = this.command(config, commandResults, context);
    } else {
      cmdString = this.command;
    }

    // If we're running with sudo then
    // we prepend sudo to the command
    if (this.sudo) {
      cmdString = `sudo ${cmdString}`;
    }

    // If a command parser is specified then
    // we pipe the contents of the command
    // through the command parser
    if (this.commandParser !== undefined) {
      cmdString += ` | ${this.commandParser}`;
    }

    // Run the function
    this.rawOutput = await this.execFunction(cmdString);


    // Parse the output from the command
    // If it doesn't succeed
    // we simply return the raw output
    const parseSucceeded = await this.parseOutput();
    if (!parseSucceeded) {
      return this.rawOutput;
    }

    // Run post-process hooks
    if (this.postProcessHooks !== undefined) {
      for (let i = 0; i < this.postProcessHooks.length; i++) {
        const hook = this.postProcessHooks[i];
        if (hook !== undefined) {
          this.parsedOutput.processed = hook(this.parsedOutput);
        }
      }
    }

    console.log(this.parsedOutput);

    return this.parsedOutput;
  }


  /**
   * Parse the output of the command
   * @returns
   */
  async parseOutput(): boolean {
    if (this.rawOutput === null || this.rawOutput === undefined) {
      return false;
    }

    // Copy over the initial raw output
    this.parsedOutput = this.rawOutput;


    // Parse output
    try {
      switch (this.outputType) {
        case OutputType.Json:
          this.parsedOutput.parsed = JSON.parse(this.rawOutput.stdout);
          break;

        case OutputType.Csv:
          console.warn(
            "YAML parsing requires an external library (e.g., js-yaml). Returning raw output.",
          );
          this.parsedOutput.parsed = this.rawOutput;
          break;

        case OutputType.Yaml:
          this.parsedOutput.parsed = loadAll(this.rawOutput.stdout);
          break;


        case OutputType.Custom:
          if (this.parseFunction) {
            this.parsedOutput = this.parseFunction(this.rawOutput);
          } else {
            console.warn("Custom output type requires a parseFunction.");
            this.parsedOutput = this.rawOutput;
          }
          break;

        // In the case of raw we don't do any parsing
        // any simply copy the raw stdout to parsed
        case OutputType.Raw:
          this.parsedOutput.parsed = this.parsedOutput.stdout;
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
